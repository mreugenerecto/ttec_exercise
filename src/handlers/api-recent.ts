/**
 * Read API for the bonus web app: the most recent callers and their vanity
 * numbers.
 *
 * PII IS MASKED HERE, ON PURPOSE.
 * The table stores full E.164 numbers because the IVR and support tooling need
 * them. This endpoint is reachable by anyone with the CloudFront URL, so it
 * returns "+1555***4567" and never the full number. Masking at the edge of the
 * system rather than at the storage layer is the right split: one store, many
 * consumers, each seeing only what it is entitled to.
 *
 * PRODUCTION NOTE: an unauthenticated endpoint that lists who has called a
 * business recently is still a privacy problem even masked -- an attacker who
 * already knows a number can confirm that person called. For anything real this
 * would sit behind Amazon Cognito (or IAM auth with SigV4 from an authenticated
 * app), be scoped to a tenant, and be audit-logged. I left it public because the
 * brief asks for a demo web app and adding an auth flow would have obscured the
 * part being assessed. It is called out again in docs/PRODUCTION-READINESS.md.
 */
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2, Context } from 'aws-lambda';
import { redactPhone } from '../core/phone';
import { logger } from '../lib/logger';
import { CallRepository, type CallRecord } from '../lib/repository';

/** The brief asks for the last 5. Bounded so a caller cannot ask for 10,000. */
const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 25;

const repository = new CallRepository();

export interface RecentCallView {
  readonly callerNumber: string;
  readonly requestedAt: string;
  readonly vanityNumbers: readonly { vanity: string; score: number; words: readonly string[] }[];
}

export async function handler(
  event: APIGatewayProxyEventV2,
  context?: Context,
): Promise<APIGatewayProxyResultV2> {
  const log = logger.child({
    awsRequestId: context?.awsRequestId,
    path: event?.rawPath,
    sourceIp: event?.requestContext?.http?.sourceIp,
  });

  let limit: number;
  try {
    limit = parseLimit(event?.queryStringParameters?.limit);
  } catch (error) {
    log.warn('Rejected bad limit parameter', { limit: event?.queryStringParameters?.limit });
    return json(400, { error: 'BadRequest', message: (error as Error).message });
  }

  try {
    const calls = await repository.listRecentCalls(limit);
    log.info('Served recent calls', { returned: calls.length, limit });

    return json(200, {
      generatedAt: new Date().toISOString(),
      count: calls.length,
      calls: calls.map(toView),
    });
  } catch (error) {
    log.error('Failed to read recent calls', error);
    // Never leak an SDK error message to an anonymous caller: it names the
    // table, the region, and sometimes the account.
    return json(500, { error: 'InternalError', message: 'Could not load recent calls.' });
  }
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

function toView(record: CallRecord): RecentCallView {
  return {
    callerNumber: redactPhone(record.callerNumber),
    requestedAt: record.requestedAt,
    vanityNumbers: record.vanityNumbers,
  };
}

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // The feed is inherently stale the moment it is served; 5s of shared cache
      // absorbs a refresh-hammering browser without making the page feel dead.
      'cache-control': statusCode === 200 ? 'public, max-age=5' : 'no-store',
      // Defence in depth. The app is served same-origin through CloudFront, so
      // these mostly matter if someone hits the API Gateway URL directly.
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
    body: JSON.stringify(body),
  };
}
