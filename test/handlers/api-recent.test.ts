const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { __resetConfigForTests } from '../../src/lib/config';
import { handler } from '../../src/handlers/api-recent';

function apiEvent(query: Record<string, string> = {}): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'GET /api/recent',
    rawPath: '/api/recent',
    rawQueryString: '',
    headers: {},
    queryStringParameters: query,
    requestContext: {
      http: { method: 'GET', path: '/api/recent', sourceIp: '203.0.113.7', protocol: 'HTTP/1.1', userAgent: 'jest' },
    },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function dbItem(iso: string, number: string, id: string) {
  return {
    gsi1sk: `${iso}#${id}`,
    callerNumber: number,
    contactId: id,
    requestedAt: iso,
    vanityNumbers: [{ vanity: '1-888-HELP-NOW', score: 88.9, words: ['HELP', 'NOW'] }],
  };
}

function body(result: Awaited<ReturnType<typeof handler>>) {
  return JSON.parse((result as { body: string }).body);
}

let consoleSpies: jest.SpyInstance[];

beforeEach(() => {
  mockSend.mockReset();
  process.env.TABLE_NAME = 'test-calls';
  process.env.RECENT_SHARD_COUNT = '1';
  __resetConfigForTests();
  consoleSpies = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'warn').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => consoleSpies.forEach((spy) => spy.mockRestore()));

describe('GET /api/recent', () => {
  it('returns the five most recent calls by default', async () => {
    mockSend.mockResolvedValue({ Items: [dbItem('2026-08-30T10:00:00.000Z', '+18884357669', 'c1')] });

    const result = await handler(apiEvent());
    expect((result as { statusCode: number }).statusCode).toBe(200);

    const payload = body(result);
    expect(payload.count).toBe(1);
    expect(payload.calls[0].vanityNumbers[0].vanity).toBe('1-888-HELP-NOW');
    expect(mockSend.mock.calls[0][0].input.Limit).toBe(5);
  });

  it('MASKS the caller number -- this endpoint is public', async () => {
    mockSend.mockResolvedValue({ Items: [dbItem('2026-08-30T10:00:00.000Z', '+18884357669', 'c1')] });

    const result = await handler(apiEvent());
    const raw = (result as { body: string }).body;

    expect(raw).not.toContain('+18884357669');
    expect(body(result).calls[0].callerNumber).toBe('+1888***7669');
  });

  it('does not leak the contact id, which is an internal identifier', async () => {
    mockSend.mockResolvedValue({ Items: [dbItem('2026-08-30T10:00:00.000Z', '+18884357669', 'c1')] });
    expect(body(await handler(apiEvent())).calls[0]).not.toHaveProperty('contactId');
  });

  it('accepts an explicit limit within bounds', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    await handler(apiEvent({ limit: '10' }));
    expect(mockSend.mock.calls[0][0].input.Limit).toBe(10);
  });

  it.each(['0', '-1', '26', '1000', 'abc', '2.5', '5; DROP TABLE'])(
    'rejects limit=%s with a 400 rather than obeying it',
    async (limit) => {
      const result = await handler(apiEvent({ limit }));
      expect((result as { statusCode: number }).statusCode).toBe(400);
      expect(body(result).error).toBe('BadRequest');
      // The clamp happens before any I/O, so a bad request costs nothing.
      expect(mockSend).not.toHaveBeenCalled();
    },
  );

  it('treats a blank limit as unset rather than as an error', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    const result = await handler(apiEvent({ limit: '  ' }));
    expect((result as { statusCode: number }).statusCode).toBe(200);
    expect(mockSend.mock.calls[0][0].input.Limit).toBe(5);
  });

  it('returns an empty list, not an error, when nothing has been recorded', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    const payload = body(await handler(apiEvent()));
    expect(payload.count).toBe(0);
    expect(payload.calls).toEqual([]);
  });

  it('sets a short cache header so refresh-hammering is absorbed at the edge', async () => {
    mockSend.mockResolvedValue({ Items: [] });
    const headers = (await handler(apiEvent())) as { headers: Record<string, string> };
    expect(headers.headers['cache-control']).toBe('public, max-age=5');
    expect(headers.headers['content-type']).toMatch(/application\/json/);
    expect(headers.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('failures', () => {
  it('returns 500 without leaking the underlying AWS error', async () => {
    mockSend.mockRejectedValue(
      new Error('ResourceNotFoundException: Requested resource not found: Table: prod-calls'),
    );

    const result = await handler(apiEvent());
    expect((result as { statusCode: number }).statusCode).toBe(500);

    const raw = (result as { body: string }).body;
    expect(raw).not.toContain('prod-calls');
    expect(raw).not.toContain('ResourceNotFoundException');
    expect(body(result).message).toBe('Could not load recent calls.');
  });

  it('still logs the real error server-side', async () => {
    mockSend.mockRejectedValue(new Error('ResourceNotFoundException'));
    await handler(apiEvent());

    const errors = (console.error as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]));
    expect(errors[0].errorMessage).toContain('ResourceNotFoundException');
  });

  it('sets no-store on error responses', async () => {
    mockSend.mockRejectedValue(new Error('nope'));
    const result = (await handler(apiEvent())) as { headers: Record<string, string> };
    expect(result.headers['cache-control']).toBe('no-store');
  });
});
