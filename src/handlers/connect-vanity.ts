/**
 * Amazon Connect contact-flow Lambda.
 *
 * Invoked mid-call from an "Invoke AWS Lambda function" block. Reads the
 * caller's number off the contact, computes vanity numbers, persists the best
 * five, and returns the top three in a shape the flow can speak.
 *
 * TWO HARD CONSTRAINTS FROM AMAZON CONNECT SHAPE THIS FILE:
 *
 *  1. The response must be a FLAT map of string key/value pairs (no nesting, no
 *     arrays) and under 32 KB. That is why the results are flattened into
 *     `vanity1..vanityN` rather than returned as a list. `$.External.vanity1` is
 *     then addressable directly from the flow.
 *
 *  2. The flow gives the Lambda at most 8 seconds before it takes the error
 *     branch, and the caller is listening to silence for all of it. So every
 *     failure mode here degrades to *something sayable* rather than throwing.
 *     Throwing is reserved for cases where there is genuinely nothing to say.
 *
 * DELIBERATE DESIGN CHOICE -- PERSISTENCE IS BEST EFFORT.
 * If the DynamoDB write fails, we log an ERROR (which is alarmed on) and still
 * return the vanity numbers. A caller should never hear "sorry, something went
 * wrong" because a table throttled; the call is the product, the analytics
 * record is not. In production I would remove the tradeoff entirely by making
 * the handler write to an SQS queue (or EventBridge) and having a second Lambda
 * own the durable write, so the call path has no database dependency at all and
 * failed writes retry into a DLQ instead of being logged and lost.
 */
import type { Context } from 'aws-lambda';
import { generateVanityNumbers, type VanityCandidate } from '../core/vanity';
import { buildVanitySpeech, vanityToSsml } from '../core/speech';
import { redactPhone } from '../core/phone';
import { config } from '../lib/config';
import { logger } from '../lib/logger';
import { CallRepository } from '../lib/repository';

/** The subset of the Connect contact-flow event this handler relies on. */
export interface ConnectContactFlowEvent {
  readonly Details?: {
    readonly ContactData?: {
      readonly ContactId?: string;
      readonly InitialContactId?: string;
      readonly InstanceARN?: string;
      readonly Channel?: string;
      readonly CustomerEndpoint?: { readonly Address?: string; readonly Type?: string };
      readonly SystemEndpoint?: { readonly Address?: string; readonly Type?: string };
      readonly Attributes?: Record<string, string>;
    };
    /** Parameters configured on the Invoke Lambda block in the flow. */
    readonly Parameters?: Record<string, string>;
  };
  readonly Name?: string;
}

/** Every value is a string: Connect rejects nested or non-scalar responses. */
export type ConnectResponse = Record<string, string>;

export type VanityStatus =
  | 'OK' // vanity numbers found
  | 'NO_VANITY' // valid number, but no words fit (lots of 0s and 1s)
  | 'NO_CALLER_ID' // withheld or missing caller ID
  | 'UNSUPPORTED_NUMBER' // valid, but not a NANP number
  | 'INVALID_NUMBER'; // could not be parsed at all

const STATUS_MESSAGES: Record<VanityStatus, string> = {
  OK: '',
  NO_VANITY:
    'Sorry, your phone number does not spell any words. Numbers with lots of zeros and ones have very few letter combinations.',
  NO_CALLER_ID:
    'Sorry, we could not read your caller I D, so we cannot generate vanity numbers for you.',
  UNSUPPORTED_NUMBER:
    'Sorry, vanity numbers are only available for North American phone numbers at this time.',
  INVALID_NUMBER: 'Sorry, we could not understand your phone number.',
};

// Instantiated at module scope so the DynamoDB client and its connection pool
// survive between warm invocations.
const repository = new CallRepository();

export async function handler(
  event: ConnectContactFlowEvent,
  context?: Context,
): Promise<ConnectResponse> {
  const cfg = config();
  const contactData = event?.Details?.ContactData;
  const contactId = contactData?.ContactId ?? contactData?.InitialContactId ?? synthesiseContactId();

  const log = logger.child({
    contactId,
    awsRequestId: context?.awsRequestId,
    channel: contactData?.Channel,
  });

  // A `phoneNumber` parameter on the Invoke Lambda block overrides the real
  // caller ID. This exists so the flow (and a reviewer with the Connect test
  // tool, or `aws lambda invoke`) can exercise specific numbers without needing
  // a phone that dials from them. Test hooks in production code are a smell
  // unless they are documented and inert by default -- this one is both.
  const overrideNumber = event?.Details?.Parameters?.phoneNumber;
  const callerNumber = overrideNumber ?? contactData?.CustomerEndpoint?.Address;

  if (overrideNumber) {
    log.warn('Using phoneNumber override from flow parameters', {
      phone: redactPhone(overrideNumber),
    });
  }

  const startedAt = Date.now();
  const result = generateVanityNumbers(callerNumber, { maxResults: cfg.resultsToStore });

  if (!result.ok) {
    const status: VanityStatus =
      result.reason === 'MISSING' || result.reason === 'ANONYMOUS'
        ? 'NO_CALLER_ID'
        : result.reason === 'NOT_NANP'
          ? 'UNSUPPORTED_NUMBER'
          : 'INVALID_NUMBER';

    log.info('No vanity numbers generated', {
      status,
      reason: result.reason,
      phone: redactPhone(callerNumber),
    });
    return failureResponse(status, callerNumber);
  }

  const stored = result.candidates.slice(0, cfg.resultsToStore);
  const spoken = stored.slice(0, cfg.resultsToSpeak);

  log.info('Generated vanity numbers', {
    phone: redactPhone(result.phone.e164),
    generated: stored.length,
    explored: result.explored,
    truncated: result.truncated,
    durationMs: Date.now() - startedAt,
  });

  if (stored.length === 0) {
    return failureResponse('NO_VANITY', result.phone.e164);
  }

  const requestedAt = new Date().toISOString();
  let persisted = true;
  try {
    await repository.putCall({
      callerNumber: result.phone.e164,
      contactId,
      requestedAt,
      vanityNumbers: stored.map((c) => ({ vanity: c.vanity, score: c.score, words: [...c.words] })),
    });
  } catch (error) {
    persisted = false;
    // ERROR level on purpose: this is alarmed on in the CDK stack. The caller
    // still gets their numbers -- see the module comment.
    log.error('Failed to persist call record; continuing so the caller is still served', error, {
      phone: redactPhone(result.phone.e164),
    });
  }

  const speech = buildVanitySpeech(spoken);

  const response: ConnectResponse = {
    status: 'OK',
    message: '',
    callerNumber: result.phone.e164,
    vanityCount: String(spoken.length),
    storedCount: String(stored.length),
    persisted: String(persisted),
    vanitySpeechSsml: speech.ssml,
    vanitySpeechText: speech.text,
  };

  flattenCandidates(spoken, response);
  return response;
}

/** Connect cannot read arrays, so results become vanity1/vanity1Score/... keys. */
function flattenCandidates(candidates: readonly VanityCandidate[], into: ConnectResponse): void {
  candidates.forEach((candidate, i) => {
    const n = i + 1;
    into[`vanity${n}`] = candidate.vanity;
    into[`vanity${n}Score`] = String(candidate.score);
    into[`vanity${n}Ssml`] = vanityToSsml(candidate.vanity);
  });
}

function failureResponse(status: VanityStatus, callerNumber?: string | null): ConnectResponse {
  const message = STATUS_MESSAGES[status];
  return {
    status,
    message,
    // Echo back what we saw so the flow can branch, but never invent a value.
    callerNumber: callerNumber ?? '',
    vanityCount: '0',
    storedCount: '0',
    persisted: 'false',
    vanitySpeechSsml: message,
    vanitySpeechText: message,
  };
}

/**
 * Connect always supplies a contact id. This only fires for direct `aws lambda
 * invoke` testing, and is prefixed so those rows are obvious in the table.
 */
function synthesiseContactId(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
