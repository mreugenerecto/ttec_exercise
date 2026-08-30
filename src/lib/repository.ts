/**
 * DynamoDB access for call records.
 *
 * TABLE DESIGN
 * ------------
 *   pk = CALLER#<e164>                       partition per caller
 *   sk = CALL#<isoTimestamp>#<contactId>     one item per call, newest last
 *
 * Partitioning by caller means "everything about this caller" is a single-
 * partition Query, which is the access pattern support staff and the IVR
 * actually have. Making the sort key time-ordered means "their most recent call"
 * is a Query with `ScanIndexForward: false, Limit: 1` and no filtering.
 * Appending the Connect contact id keeps the key unique when a caller manages
 * two calls inside the same millisecond (redial storms, automated dialers).
 *
 * THE "LAST 5 CALLERS" PROBLEM
 * ----------------------------
 * The web app needs the most recent calls *across all callers*, which is exactly
 * the query DynamoDB is worst at. The options were:
 *
 *   a) Scan + sort in the Lambda. O(table). Fine at 50 items, catastrophic at
 *      50 million. Rejected: it works right up until the demo becomes a product.
 *   b) A GSI with one constant partition key and a timestamp sort key. One
 *      Query, always cheap to read -- but every write in the system lands on one
 *      partition, which caps sustained writes at ~1000 WCU and creates a hot
 *      key.
 *   c) (b), but with the partition key sharded across N values, fanning the read
 *      out over N parallel Queries and merging.
 *
 * I implemented (c) with N configurable and defaulting to 1, so this exercise
 * runs as the simple (b) and a production deployment raises RECENT_SHARD_COUNT
 * without a code change or a data migration -- old items keep their shard, new
 * items spread out, and the reader already fans out. The cost of a read is N
 * Queries of `limit` items each; at N=10 and limit=5 that is trivial.
 *
 * PRODUCTION NOTE: past a few thousand writes/second I would stop trying to make
 * DynamoDB do a global feed at all, and instead fan DynamoDB Streams into
 * something built for it (a small ElastiCache sorted set, or OpenSearch if the
 * feed needs filtering). The table stays the system of record; the feed becomes
 * a derived, disposable read model.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { createHash } from 'crypto';
import { config } from './config';

export interface StoredVanityNumber {
  readonly vanity: string;
  readonly score: number;
  readonly words: readonly string[];
}

export interface CallRecord {
  /** Caller number in E.164. PII -- see the masking note in the API handler. */
  readonly callerNumber: string;
  /** Amazon Connect contact id, or a synthetic id when invoked outside Connect. */
  readonly contactId: string;
  /** ISO-8601 UTC. */
  readonly requestedAt: string;
  /** Best N vanity numbers, best first. */
  readonly vanityNumbers: readonly StoredVanityNumber[];
}

interface CallItem extends CallRecord {
  readonly pk: string;
  readonly sk: string;
  readonly gsi1pk: string;
  readonly gsi1sk: string;
  /** Unix epoch seconds. DynamoDB TTL attribute. */
  readonly expiresAt: number;
}

export const callerPk = (e164: string): string => `CALLER#${e164}`;
export const callSk = (requestedAt: string, contactId: string): string =>
  `CALL#${requestedAt}#${contactId}`;

/**
 * Deterministically map a call to one of `shardCount` feed partitions.
 * Hashing the contact id (rather than using a random number) keeps writes
 * idempotent: a retried invocation of the same contact lands on the same shard
 * and overwrites its own item instead of creating a duplicate feed entry.
 */
export function recentShardKey(contactId: string, shardCount: number): string {
  if (shardCount <= 1) return 'RECENT#0';
  const digest = createHash('sha256').update(contactId).digest();
  return `RECENT#${digest.readUInt32BE(0) % shardCount}`;
}

/** Shared client. Created once per execution environment, reused when warm. */
let documentClient: DynamoDBDocumentClient | null = null;

function client(): DynamoDBDocumentClient {
  if (documentClient === null) {
    documentClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        // Fail fast rather than hold a Connect call open: the contact flow gives
        // us 8 seconds total, so 3 attempts of ~1s beats one long hang.
        maxAttempts: 3,
      }),
      { marshallOptions: { removeUndefinedValues: true } },
    );
  }
  return documentClient;
}

/** Test seam: inject a stubbed document client. */
export function __setDocumentClientForTests(stub: DynamoDBDocumentClient | null): void {
  documentClient = stub;
}

export class CallRepository {
  constructor(private readonly doc: DynamoDBDocumentClient = client()) {}

  /** Persist one call's results. Overwrites on retry of the same contact id. */
  async putCall(record: CallRecord): Promise<void> {
    const cfg = config();
    const item: CallItem = {
      ...record,
      pk: callerPk(record.callerNumber),
      sk: callSk(record.requestedAt, record.contactId),
      gsi1pk: recentShardKey(record.contactId, cfg.recentShardCount),
      gsi1sk: `${record.requestedAt}#${record.contactId}`,
      expiresAt: Math.floor(Date.parse(record.requestedAt) / 1000) + cfg.retentionDays * 86400,
    };

    await this.doc.send(
      new PutCommand({
        TableName: cfg.tableName,
        Item: item,
      }),
    );
  }

  /**
   * The `limit` most recent calls across all callers, newest first.
   * Fans out across feed shards and merges; see the module comment.
   */
  async listRecentCalls(limit: number): Promise<CallRecord[]> {
    const cfg = config();
    const shardCount = Math.max(1, cfg.recentShardCount);

    const queries: Promise<QueryCommandOutput>[] = [];
    for (let shard = 0; shard < shardCount; shard++) {
      queries.push(
        this.doc.send(
          new QueryCommand({
            TableName: cfg.tableName,
            IndexName: cfg.recentIndexName,
            KeyConditionExpression: 'gsi1pk = :pk',
            ExpressionAttributeValues: { ':pk': `RECENT#${shard}` },
            // Descending on the timestamp sort key: newest first, no sorting in
            // DynamoDB and no filter scan.
            ScanIndexForward: false,
            Limit: limit,
          }),
        ),
      );
    }

    // Promise.all, not allSettled: a partial feed is a silently wrong feed. If a
    // shard query fails we would rather surface the error and let the API return
    // 5xx than quietly show the user an incomplete list.
    const responses = await Promise.all(queries);

    const merged = responses
      .flatMap((response) => (response.Items ?? []) as CallItem[])
      .sort((a, b) => b.gsi1sk.localeCompare(a.gsi1sk))
      .slice(0, limit);

    return merged.map(toCallRecord);
  }

  /** Most recent calls for a single caller, newest first. */
  async listCallsForCaller(e164: string, limit: number): Promise<CallRecord[]> {
    const cfg = config();
    const response = await this.doc.send(
      new QueryCommand({
        TableName: cfg.tableName,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': callerPk(e164) },
        ScanIndexForward: false,
        Limit: limit,
      }),
    );
    return ((response.Items ?? []) as CallItem[]).map(toCallRecord);
  }
}

/** Strip internal key attributes before the record leaves the data layer. */
function toCallRecord(item: CallItem): CallRecord {
  return {
    callerNumber: item.callerNumber,
    contactId: item.contactId,
    requestedAt: item.requestedAt,
    vanityNumbers: item.vanityNumbers ?? [],
  };
}
