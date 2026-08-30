/**
 * The contact flow is a JSON graph that Amazon Connect validates only at deploy
 * time, and a broken edge shows up as a caller hearing silence. These tests are
 * the cheap version of that feedback loop: they assert the graph is connected,
 * terminates, and references the Lambda we think it does.
 */
import { buildVanityContactFlow, CONTACT_FLOW_ACTION_IDS } from '../../lib/contact-flows/vanity-flow';

const LAMBDA_ARN = 'arn:aws:lambda:us-east-1:123456789012:function:VanityFunction';

interface FlowAction {
  Identifier: string;
  Type: string;
  Parameters: Record<string, unknown>;
  Transitions: {
    NextAction?: string;
    Errors?: { NextAction: string; ErrorType: string }[];
    Conditions?: { NextAction: string; Condition: { Operator: string; Operands: string[] } }[];
  };
}

function parseFlow(overrides = {}) {
  return JSON.parse(
    buildVanityContactFlow({ lambdaFunctionArn: LAMBDA_ARN, ...overrides }),
  ) as {
    Version: string;
    StartAction: string;
    Metadata: Record<string, unknown>;
    Actions: FlowAction[];
  };
}

/** Every identifier a transition can point at. */
function outgoingTargets(action: FlowAction): string[] {
  return [
    action.Transitions.NextAction,
    ...(action.Transitions.Errors ?? []).map((e) => e.NextAction),
    ...(action.Transitions.Conditions ?? []).map((c) => c.NextAction),
  ].filter((x): x is string => typeof x === 'string');
}

describe('contact flow structure', () => {
  it('uses the flow language version Amazon Connect expects', () => {
    expect(parseFlow().Version).toBe('2019-10-30');
  });

  it('starts at an action that exists', () => {
    const flow = parseFlow();
    expect(flow.Actions.map((a) => a.Identifier)).toContain(flow.StartAction);
  });

  it('has unique identifiers', () => {
    const ids = parseFlow().Actions.map((a) => a.Identifier);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has no transition pointing at a non-existent action', () => {
    const flow = parseFlow();
    const ids = new Set(flow.Actions.map((a) => a.Identifier));
    for (const action of flow.Actions) {
      for (const target of outgoingTargets(action)) {
        expect(ids.has(target)).toBe(true);
      }
    }
  });

  it('has no orphaned action -- every block is reachable from the start', () => {
    const flow = parseFlow();
    const byId = new Map(flow.Actions.map((a) => [a.Identifier, a]));
    const seen = new Set<string>([flow.StartAction]);
    const queue = [flow.StartAction];

    while (queue.length > 0) {
      const current = byId.get(queue.pop()!)!;
      for (const target of outgoingTargets(current)) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }

    expect(seen.size).toBe(flow.Actions.length);
  });

  it('terminates: every path ends at the single disconnect block', () => {
    const flow = parseFlow();
    const terminal = flow.Actions.filter((a) => outgoingTargets(a).length === 0);
    expect(terminal).toHaveLength(1);
    expect(terminal[0].Type).toBe('DisconnectParticipant');
    expect(terminal[0].Identifier).toBe(CONTACT_FLOW_ACTION_IDS.disconnect);
  });
});

describe('behaviour the caller actually experiences', () => {
  it('invokes the Lambda we were given', () => {
    const invoke = parseFlow().Actions.find((a) => a.Type === 'InvokeLambdaFunction')!;
    expect(invoke.Parameters.LambdaFunctionARN).toBe(LAMBDA_ARN);
  });

  it('stays within Amazon Connect 8 second invocation ceiling', () => {
    const invoke = parseFlow().Actions.find((a) => a.Type === 'InvokeLambdaFunction')!;
    expect(Number(invoke.Parameters.InvocationTimeLimitSeconds)).toBeLessThanOrEqual(8);
  });

  it('routes a Lambda failure to a spoken apology, never to silence', () => {
    const flow = parseFlow();
    const invoke = flow.Actions.find((a) => a.Type === 'InvokeLambdaFunction')!;
    const errorTarget = invoke.Transitions.Errors![0].NextAction;
    const errorAction = flow.Actions.find((a) => a.Identifier === errorTarget)!;

    expect(errorAction.Type).toBe('MessageParticipant');
    expect(String(errorAction.Parameters.Text)).toMatch(/not responding/i);
  });

  it('branches on the Lambda status and speaks results only when it is OK', () => {
    const flow = parseFlow();
    const compare = flow.Actions.find((a) => a.Type === 'Compare')!;
    expect(compare.Parameters.ComparisonValue).toBe('$.External.status');

    const okBranch = compare.Transitions.Conditions!.find((c) =>
      c.Condition.Operands.includes('OK'),
    )!;
    expect(okBranch).toBeDefined();
    expect(okBranch.Condition.Operator).toBe('Equals');

    // The default edge must go somewhere that speaks, not nowhere.
    const fallback = flow.Actions.find((a) => a.Identifier === compare.Transitions.NextAction)!;
    expect(fallback.Type).toBe('MessageParticipant');
  });

  it('speaks the results as SSML, since plain text mangles the letters', () => {
    const flow = parseFlow();
    const speak = flow.Actions.find(
      (a) => a.Identifier === CONTACT_FLOW_ACTION_IDS.speakResults,
    )!;
    expect(speak.Parameters.SSML).toBe('$.External.vanitySpeechSsml');
    expect(speak.Parameters.Text).toBeUndefined();
  });

  it('stamps the results onto the contact so they appear in the CTR', () => {
    const flow = parseFlow();
    const attributes = flow.Actions.find((a) => a.Type === 'UpdateContactAttributes')!;
    expect(attributes.Parameters.Attributes).toMatchObject({
      vanity1: '$.External.vanity1',
      vanity2: '$.External.vanity2',
      vanity3: '$.External.vanity3',
    });
  });

  it('turns on flow logging, without which a hung call is undebuggable', () => {
    const flow = parseFlow();
    const logging = flow.Actions.find((a) => a.Type === 'UpdateFlowLoggingBehavior')!;
    expect(logging.Parameters.FlowLoggingBehavior).toBe('Enabled');
    expect(flow.StartAction).toBe(logging.Identifier);
  });

  it('sets a neural Polly voice before anything is spoken', () => {
    const flow = parseFlow();
    const voice = flow.Actions.find((a) => a.Type === 'UpdateContactTextToSpeechVoice')!;
    expect(voice.Parameters.TextToSpeechEngine).toBe('Neural');
    expect(voice.Parameters.TextToSpeechVoice).toBe('Joanna');
  });

  it('accepts a custom voice and name', () => {
    const flow = parseFlow({ voiceId: 'Matthew', name: 'Custom Flow' });
    const voice = flow.Actions.find((a) => a.Type === 'UpdateContactTextToSpeechVoice')!;
    expect(voice.Parameters.TextToSpeechVoice).toBe('Matthew');
    expect(flow.Metadata.name).toBe('Custom Flow');
  });
});

describe('console metadata', () => {
  it('positions every action so the flow opens as a readable diagram', () => {
    const flow = parseFlow();
    const metadata = flow.Metadata.ActionMetadata as Record<string, { position?: unknown }>;
    for (const action of flow.Actions) {
      expect(metadata[action.Identifier]?.position).toBeDefined();
    }
  });
});
