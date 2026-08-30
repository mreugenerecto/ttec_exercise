/**
 * The Amazon Connect contact flow, built as code.
 *
 * WHY GENERATED RATHER THAN A CHECKED-IN JSON BLOB:
 * A contact flow's JSON hard-codes the ARN of every Lambda it invokes. If the
 * flow were a static file, deploying into a reviewer's account would mean
 * string-replacing an ARN into it at synth time -- which works, but hides the
 * dependency and silently produces a broken flow if the placeholder ever drifts.
 * Building it from a typed function means the ARN is a parameter, the prompts
 * are readable in a diff, and the whole thing is unit-testable (see
 * test/infra/contact-flow.test.ts) instead of being a wall of unreviewable JSON.
 *
 * FLOW SHAPE
 *
 *   logging -> voice -> greeting -> invokeLambda
 *                                       |
 *                        +--------------+--------------+
 *                        | success                     | error / timeout
 *                        v                             v
 *                     compare status              lambdaFailure
 *                        |         |                   |
 *                 OK     |         | anything else     |
 *                        v         v                   |
 *                setAttributes   speakMessage          |
 *                        |         |                   |
 *                        v         |                   |
 *                  speakResults    |                   |
 *                        |         |                   |
 *                        +----> goodbye <--------------+
 *                                  |
 *                                  v
 *                             disconnect
 *
 * Every branch terminates in a spoken sentence and a clean disconnect. There is
 * no path on which the caller hears silence -- including Lambda timeout, which
 * is the failure mode that actually happens in production.
 *
 * IDENTIFIERS are fixed UUIDs rather than generated ones. Amazon Connect keys
 * transitions on them, and stable ids mean redeploying produces a clean diff
 * instead of rewriting every edge in the flow.
 */

/** Fixed action identifiers. Do not renumber: they are the flow's edge labels. */
const ID = {
  logging: '11111111-0000-4000-8000-000000000001',
  voice: '11111111-0000-4000-8000-000000000002',
  greeting: '11111111-0000-4000-8000-000000000003',
  invokeLambda: '11111111-0000-4000-8000-000000000004',
  compareStatus: '11111111-0000-4000-8000-000000000005',
  setAttributes: '11111111-0000-4000-8000-000000000006',
  speakResults: '11111111-0000-4000-8000-000000000007',
  speakMessage: '11111111-0000-4000-8000-000000000008',
  lambdaFailure: '11111111-0000-4000-8000-000000000009',
  goodbye: '11111111-0000-4000-8000-00000000000a',
  disconnect: '11111111-0000-4000-8000-00000000000b',
} as const;

export interface ContactFlowOptions {
  /** ARN of the vanity Lambda. Must already be associated with the instance. */
  readonly lambdaFunctionArn: string;
  /** Flow name, shown in the Connect console. */
  readonly name?: string;
  /**
   * Seconds Connect waits for the Lambda. Connect's ceiling is 8. We size the
   * Lambda timeout *below* this so the Lambda fails first and we get a useful
   * CloudWatch error instead of an opaque flow-side timeout.
   */
  readonly invocationTimeLimitSeconds?: number;
  /** Polly voice. Neural engine costs marginally more and sounds far better. */
  readonly voiceId?: string;
}

interface Transitions {
  NextAction?: string;
  Errors?: { NextAction: string; ErrorType: string }[];
  Conditions?: { NextAction: string; Condition: { Operator: string; Operands: string[] } }[];
}

interface Action {
  Parameters: Record<string, unknown>;
  Identifier: string;
  Type: string;
  Transitions: Transitions;
}

/** Standard "no matching error" edge, pointed wherever we want failures to go. */
const onError = (next: string): Transitions['Errors'] => [
  { NextAction: next, ErrorType: 'NoMatchingError' },
];

export function buildVanityContactFlow(options: ContactFlowOptions): string {
  const name = options.name ?? 'Vanity Number Lookup';
  const timeLimit = String(options.invocationTimeLimitSeconds ?? 8);
  const voiceId = options.voiceId ?? 'Joanna';

  const actions: Action[] = [
    {
      // Flow logging writes every block transition to CloudWatch. It is the only
      // way to debug a flow that "just hangs up", and it is off by default.
      Parameters: { FlowLoggingBehavior: 'Enabled' },
      Identifier: ID.logging,
      Type: 'UpdateFlowLoggingBehavior',
      Transitions: { NextAction: ID.voice, Errors: [], Conditions: [] },
    },
    {
      Parameters: {
        TextToSpeechVoice: voiceId,
        TextToSpeechEngine: 'Neural',
        TextToSpeechStyle: 'None',
      },
      Identifier: ID.voice,
      Type: 'UpdateContactTextToSpeechVoice',
      Transitions: { NextAction: ID.greeting, Errors: [], Conditions: [] },
    },
    {
      Parameters: {
        Text:
          'Thanks for calling the vanity number line. ' +
          'One moment while we find the best vanity numbers for the number you are calling from.',
      },
      Identifier: ID.greeting,
      Type: 'MessageParticipant',
      Transitions: { NextAction: ID.invokeLambda, Errors: onError(ID.invokeLambda), Conditions: [] },
    },
    {
      Parameters: {
        LambdaFunctionARN: options.lambdaFunctionArn,
        InvocationTimeLimitSeconds: timeLimit,
      },
      Identifier: ID.invokeLambda,
      Type: 'InvokeLambdaFunction',
      // The error edge covers invocation failure, an unparseable response, AND
      // timeout. All three sound identical to a caller, so they share a prompt.
      Transitions: {
        NextAction: ID.compareStatus,
        Errors: onError(ID.lambdaFailure),
        Conditions: [],
      },
    },
    {
      Parameters: { ComparisonValue: '$.External.status' },
      Identifier: ID.compareStatus,
      Type: 'Compare',
      Transitions: {
        // Default edge: anything that is not OK is a business-level "we have
        // nothing for you", and the Lambda already supplied the sentence.
        NextAction: ID.speakMessage,
        Errors: [{ NextAction: ID.speakMessage, ErrorType: 'NoMatchingCondition' }],
        Conditions: [
          { NextAction: ID.setAttributes, Condition: { Operator: 'Equals', Operands: ['OK'] } },
        ],
      },
    },
    {
      // Stamping the results onto the contact makes them visible in the contact
      // trace record, so a support agent can see what the caller was told
      // without going near CloudWatch.
      Parameters: {
        Attributes: {
          vanity1: '$.External.vanity1',
          vanity2: '$.External.vanity2',
          vanity3: '$.External.vanity3',
          vanityPersisted: '$.External.persisted',
        },
      },
      Identifier: ID.setAttributes,
      Type: 'UpdateContactAttributes',
      Transitions: { NextAction: ID.speakResults, Errors: onError(ID.speakResults), Conditions: [] },
    },
    {
      // SSML, not Text: see src/core/speech.ts for why plain text is unusable here.
      Parameters: { SSML: '$.External.vanitySpeechSsml' },
      Identifier: ID.speakResults,
      Type: 'MessageParticipant',
      Transitions: { NextAction: ID.goodbye, Errors: onError(ID.goodbye), Conditions: [] },
    },
    {
      Parameters: { Text: '$.External.message' },
      Identifier: ID.speakMessage,
      Type: 'MessageParticipant',
      Transitions: { NextAction: ID.goodbye, Errors: onError(ID.goodbye), Conditions: [] },
    },
    {
      Parameters: {
        Text:
          'Sorry, our vanity number service is not responding right now. ' +
          'Please try your call again in a few minutes.',
      },
      Identifier: ID.lambdaFailure,
      Type: 'MessageParticipant',
      Transitions: { NextAction: ID.goodbye, Errors: onError(ID.goodbye), Conditions: [] },
    },
    {
      Parameters: { Text: 'Thanks for calling. Goodbye.' },
      Identifier: ID.goodbye,
      Type: 'MessageParticipant',
      Transitions: { NextAction: ID.disconnect, Errors: onError(ID.disconnect), Conditions: [] },
    },
    {
      Parameters: {},
      Identifier: ID.disconnect,
      Type: 'DisconnectParticipant',
      Transitions: {},
    },
  ];

  const flow = {
    Version: '2019-10-30',
    StartAction: ID.logging,
    Metadata: {
      entryPointPosition: { x: 20, y: 20 },
      ActionMetadata: buildActionMetadata(),
      Annotations: [],
      name,
      description: 'Reads the caller ID, calls the vanity Lambda, speaks the top 3 results.',
      type: 'contactFlow',
      status: 'PUBLISHED',
      hash: {},
    },
    Actions: actions,
  };

  return JSON.stringify(flow);
}

/**
 * Console layout hints. Purely cosmetic -- Connect ignores Metadata at runtime
 * -- but a flow that opens as a readable left-to-right diagram is much easier
 * for a reviewer to trust than one where every block is stacked at the origin.
 */
function buildActionMetadata(): Record<string, unknown> {
  const positions: Record<string, { x: number; y: number }> = {
    [ID.logging]: { x: 180, y: 20 },
    [ID.voice]: { x: 400, y: 20 },
    [ID.greeting]: { x: 620, y: 20 },
    [ID.invokeLambda]: { x: 840, y: 20 },
    [ID.compareStatus]: { x: 1060, y: 20 },
    [ID.setAttributes]: { x: 1280, y: 20 },
    [ID.speakResults]: { x: 1500, y: 20 },
    [ID.speakMessage]: { x: 1280, y: 240 },
    [ID.lambdaFailure]: { x: 1060, y: 440 },
    [ID.goodbye]: { x: 1720, y: 240 },
    [ID.disconnect]: { x: 1940, y: 240 },
  };

  const metadata: Record<string, unknown> = {};
  for (const [identifier, position] of Object.entries(positions)) {
    metadata[identifier] = { position };
  }

  // Tell the console these parameters are attribute references, so the blocks
  // render as "Set dynamically" instead of literal text.
  metadata[ID.speakResults] = {
    position: positions[ID.speakResults],
    useDynamic: true,
    dynamicParams: ['vanitySpeechSsml'],
  };
  metadata[ID.speakMessage] = {
    position: positions[ID.speakMessage],
    useDynamic: true,
    dynamicParams: ['message'],
  };
  metadata[ID.compareStatus] = {
    position: positions[ID.compareStatus],
    useDynamic: true,
    conditionMetadata: [
      { id: 'vanity-ok', operator: { name: 'Equals', value: 'Equals' }, value: 'OK' },
    ],
  };

  return metadata;
}

/** Exported for tests and for anyone wiring the flow up by hand. */
export const CONTACT_FLOW_ACTION_IDS = ID;
