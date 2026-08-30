/**
 * Repository tests run against a stubbed DynamoDB document client.
 *
 * I stub at the SDK boundary rather than using DynamoDB Local or `aws-sdk-client-mock`
 * because what is worth asserting here is the *shape of the commands we send* --
 * the key structure, the index name, the sort direction, the shard fan-out. A
 * local DynamoDB would run the same commands and tell me less about them.
 *
 * PRODUCTION NOTE: I would pair these with a small integration suite that runs
 * against DynamoDB Local in CI, to catch the class of bug unit tests cannot
 * (reserved words in expressions, item size limits, real TTL semantics).
 */
const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { __resetConfigForTests } from '../../src/lib/config';
import { CallRepository, callSk, callerPk, recentShardKey } from '../../src/lib/repository';

const RECORD = {
  callerNumber: '+18884357669',
  contactId: 'contact-abc',
  requestedAt: '2026-08-30T10:00:00.000Z',
  vanityNumbers: [{ vanity: '1-888-HELP-NOW', score: 88.9, words: ['HELP', 'NOW'] }],
};

beforeEach(() => {
  mockSend.mockReset();
  process.env.TABLE_NAME = 'test-calls';
  process.env.RECENT_INDEX_NAME = 'recent-calls-index';
  process.env.RECENT_SHARD_COUNT = '1';
  process.env.RETENTION_DAYS = '90';
  __resetConfigForTests();
});

describe('key construction', () => {
  it('partitions by caller and sorts by time then contact id', () => {
    expect(callerPk('+18884357669')).toBe('CALLER#+18884357669');
    expect(callSk('2026-08-30T10:00:00.000Z', 'c1')).toBe('CALL#2026-08-30T10:00:00.000Z#c1');
  });

  it('sorts lexicographically in the same order as chronologically', () => {
    // This is the property that makes ScanIndexForward:false correct.
    const earlier = callSk('2026-08-30T09:59:59.999Z', 'c1');
    const later = callSk('2026-08-30T10:00:00.000Z', 'c1');
    expect(earlier < later).toBe(true);
  });
});

describe('recentShardKey', () => {
  it('collapses to a single shard when sharding is disabled', () => {
    expect(recentShardKey('anything', 1)).toBe('RECENT#0');
  });

  it('is deterministic, so a retried write lands on the same shard', () => {
    expect(recentShardKey('contact-abc', 8)).toBe(recentShardKey('contact-abc', 8));
  });

  it('spreads contacts across the requested number of shards', () => {
    const shards = new Set<string>();
    for (let i = 0; i < 400; i++) shards.add(recentShardKey(`contact-${i}`, 8));
    expect(shards.size).toBe(8);
  });

  it('never produces a shard outside the range', () => {
    for (let i = 0; i < 200; i++) {
      const index = Number(recentShardKey(`c-${i}`, 4).split('#')[1]);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(4);
    }
  });
});

describe('putCall', () => {
  it('writes the record with derived keys and a TTL', async () => {
    mockSend.mockResolvedValue({});
    await new CallRepository().putCall(RECORD);

    expect(mockSend).toHaveBeenCalledTimes(1);
    const { input } = mockSend.mock.calls[0][0];
    expect(input.TableName).toBe('test-calls');
    expect(input.Item.pk).toBe('CALLER#+18884357669');
    expect(input.Item.sk).toBe('CALL#2026-08-30T10:00:00.000Z#contact-abc');
    expect(input.Item.gsi1pk).toBe('RECENT#0');
    expect(input.Item.gsi1sk).toBe('2026-08-30T10:00:00.000Z#contact-abc');
    expect(input.Item.vanityNumbers).toEqual(RECORD.vanityNumbers);
  });

  it('sets the TTL retentionDays into the future, in epoch seconds', async () => {
    mockSend.mockResolvedValue({});
    await new CallRepository().putCall(RECORD);

    const { input } = mockSend.mock.calls[0][0];
    const expected = Math.floor(Date.parse(RECORD.requestedAt) / 1000) + 90 * 86400;
    expect(input.Item.expiresAt).toBe(expected);
    // Epoch *seconds*, not milliseconds -- DynamoDB silently ignores TTL values
    // in the wrong unit, which is a bug you only find months later.
    expect(String(input.Item.expiresAt)).toHaveLength(10);
  });

  it('respects a configured retention window', async () => {
    process.env.RETENTION_DAYS = '7';
    __resetConfigForTests();
    mockSend.mockResolvedValue({});
    await new CallRepository().putCall(RECORD);

    const { input } = mockSend.mock.calls[0][0];
    expect(input.Item.expiresAt).toBe(Math.floor(Date.parse(RECORD.requestedAt) / 1000) + 7 * 86400);
  });

  it('propagates write failures so the caller can decide what to do', async () => {
    mockSend.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));
    await expect(new CallRepository().putCall(RECORD)).rejects.toThrow(
      'ProvisionedThroughputExceededException',
    );
  });
});

describe('listRecentCalls', () => {
  it('queries the feed index newest-first with the requested limit', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    await new CallRepository().listRecentCalls(5);

    const { input } = mockSend.mock.calls[0][0];
    expect(input.IndexName).toBe('recent-calls-index');
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(5);
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'RECENT#0' });
  });

  it('fans out across every shard and merges into one time-ordered list', async () => {
    process.env.RECENT_SHARD_COUNT = '3';
    __resetConfigForTests();

    const item = (iso: string, id: string) => ({
      pk: `CALLER#+1888435766${id}`,
      sk: `CALL#${iso}#${id}`,
      gsi1pk: 'RECENT#0',
      gsi1sk: `${iso}#${id}`,
      callerNumber: `+1888435766${id}`,
      contactId: id,
      requestedAt: iso,
      vanityNumbers: [],
    });

    mockSend
      .mockResolvedValueOnce({ Items: [item('2026-08-30T10:00:00.000Z', '1')] })
      .mockResolvedValueOnce({ Items: [item('2026-08-30T12:00:00.000Z', '2')] })
      .mockResolvedValueOnce({ Items: [item('2026-08-30T11:00:00.000Z', '3')] });

    const calls = await new CallRepository().listRecentCalls(5);

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => c.contactId)).toEqual(['2', '3', '1']);
  });

  it('trims the merged result back to the requested limit', async () => {
    process.env.RECENT_SHARD_COUNT = '2';
    __resetConfigForTests();

    const items = (n: number, offset: number) =>
      Array.from({ length: n }, (_, i) => ({
        gsi1sk: `2026-08-30T${String(10 + offset + i).padStart(2, '0')}:00:00.000Z#c`,
        callerNumber: '+18884357669',
        contactId: `c${offset}${i}`,
        requestedAt: '2026-08-30T10:00:00.000Z',
        vanityNumbers: [],
      }));

    mockSend
      .mockResolvedValueOnce({ Items: items(3, 0) })
      .mockResolvedValueOnce({ Items: items(3, 3) });

    expect(await new CallRepository().listRecentCalls(4)).toHaveLength(4);
  });

  it('fails loudly rather than returning a silently incomplete feed', async () => {
    process.env.RECENT_SHARD_COUNT = '2';
    __resetConfigForTests();

    mockSend
      .mockResolvedValueOnce({ Items: [] })
      .mockRejectedValueOnce(new Error('ResourceNotFoundException'));

    await expect(new CallRepository().listRecentCalls(5)).rejects.toThrow(
      'ResourceNotFoundException',
    );
  });

  it('strips internal key attributes from what it returns', async () => {
    mockSend.mockResolvedValue({
      Items: [
        {
          pk: 'CALLER#+18884357669',
          sk: 'CALL#2026-08-30T10:00:00.000Z#c1',
          gsi1pk: 'RECENT#0',
          gsi1sk: '2026-08-30T10:00:00.000Z#c1',
          expiresAt: 1_800_000_000,
          callerNumber: '+18884357669',
          contactId: 'c1',
          requestedAt: '2026-08-30T10:00:00.000Z',
          vanityNumbers: [],
        },
      ],
    });

    const [call] = await new CallRepository().listRecentCalls(1);
    expect(Object.keys(call).sort()).toEqual([
      'callerNumber',
      'contactId',
      'requestedAt',
      'vanityNumbers',
    ]);
  });

  it('tolerates a legacy item with no vanityNumbers attribute', async () => {
    mockSend.mockResolvedValue({
      Items: [{ gsi1sk: 'x', callerNumber: '+1', contactId: 'c', requestedAt: 'x' }],
    });
    const [call] = await new CallRepository().listRecentCalls(1);
    expect(call.vanityNumbers).toEqual([]);
  });
});

describe('listCallsForCaller', () => {
  it('queries the base table by caller partition, newest first', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    await new CallRepository().listCallsForCaller('+18884357669', 3);

    const { input } = mockSend.mock.calls[0][0];
    expect(input.IndexName).toBeUndefined();
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'CALLER#+18884357669' });
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(3);
  });
});

describe('configuration', () => {
  it('refuses to start without a table name rather than failing mid-call', async () => {
    delete process.env.TABLE_NAME;
    __resetConfigForTests();
    await expect(new CallRepository().putCall(RECORD)).rejects.toThrow(
      /Missing required environment variable: TABLE_NAME/,
    );
  });

  it('rejects a nonsensical shard count', async () => {
    process.env.RECENT_SHARD_COUNT = 'lots';
    __resetConfigForTests();
    await expect(new CallRepository().listRecentCalls(5)).rejects.toThrow(
      /RECENT_SHARD_COUNT must be a positive integer/,
    );
  });
});
