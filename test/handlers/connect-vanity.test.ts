const mockSend = jest.fn();

jest.mock('@aws-sdk/lib-dynamodb', () => {
  const actual = jest.requireActual('@aws-sdk/lib-dynamodb');
  return {
    ...actual,
    DynamoDBDocumentClient: { from: () => ({ send: mockSend }) },
  };
});

import { __resetConfigForTests } from '../../src/lib/config';
import { handler, type ConnectContactFlowEvent } from '../../src/handlers/connect-vanity';

/** A realistic Amazon Connect contact-flow event. */
function connectEvent(
  address: string | undefined,
  overrides: Partial<ConnectContactFlowEvent> = {},
): ConnectContactFlowEvent {
  return {
    Name: 'ContactFlowEvent',
    Details: {
      ContactData: {
        ContactId: 'contact-1234',
        InitialContactId: 'contact-1234',
        InstanceARN: 'arn:aws:connect:us-east-1:123456789012:instance/abc',
        Channel: 'VOICE',
        CustomerEndpoint: address === undefined ? undefined : { Address: address, Type: 'TELEPHONE_NUMBER' },
        SystemEndpoint: { Address: '+18005551212', Type: 'TELEPHONE_NUMBER' },
        Attributes: {},
      },
      Parameters: {},
      ...overrides.Details,
    },
  };
}

let consoleSpies: jest.SpyInstance[];

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  process.env.TABLE_NAME = 'test-calls';
  process.env.RECENT_SHARD_COUNT = '1';
  process.env.RESULTS_TO_STORE = '5';
  process.env.RESULTS_TO_SPEAK = '3';
  process.env.RETENTION_DAYS = '90';
  __resetConfigForTests();
  // The handler logs structured JSON on every path; keep the test output clean
  // while still letting assertions inspect what was logged.
  consoleSpies = [
    jest.spyOn(console, 'log').mockImplementation(() => {}),
    jest.spyOn(console, 'warn').mockImplementation(() => {}),
    jest.spyOn(console, 'error').mockImplementation(() => {}),
  ];
});

afterEach(() => {
  consoleSpies.forEach((spy) => spy.mockRestore());
});

describe('happy path', () => {
  it('returns the top three vanity numbers for the caller', async () => {
    const response = await handler(connectEvent('+18884357669'));

    expect(response.status).toBe('OK');
    expect(response.vanityCount).toBe('3');
    expect(response.vanity1).toBe('1-888-HELP-NOW');
    expect(response.vanity2).toBeDefined();
    expect(response.vanity3).toBeDefined();
    expect(response.vanity4).toBeUndefined();
  });

  it('stores five but speaks three, exactly as the brief specifies', async () => {
    const response = await handler(connectEvent('+18884357669'));

    expect(response.storedCount).toBe('5');
    expect(response.vanityCount).toBe('3');

    const { input } = mockSend.mock.calls[0][0];
    expect(input.Item.vanityNumbers).toHaveLength(5);
  });

  it('returns a response Amazon Connect can actually consume', async () => {
    const response = await handler(connectEvent('+18884357669'));

    // Flat map of strings, nothing nested, comfortably under Connect's 32 KB.
    for (const [key, value] of Object.entries(response)) {
      expect(typeof value).toBe('string');
      expect(key).toMatch(/^[A-Za-z][A-Za-z0-9]*$/);
    }
    expect(Buffer.byteLength(JSON.stringify(response), 'utf8')).toBeLessThan(32 * 1024);
  });

  it('supplies SSML the flow can speak directly', async () => {
    const response = await handler(connectEvent('+18884357669'));
    expect(response.vanitySpeechSsml).toContain('<say-as interpret-as="characters">HELP</say-as>');
    expect(response.vanitySpeechSsml).not.toContain('<speak>');
    expect(response.vanitySpeechText).toContain('Option one.');
  });

  it('persists the caller number and results against the contact id', async () => {
    await handler(connectEvent('+18884357669'));

    const { input } = mockSend.mock.calls[0][0];
    expect(input.Item.callerNumber).toBe('+18884357669');
    expect(input.Item.contactId).toBe('contact-1234');
    expect(input.Item.vanityNumbers[0]).toMatchObject({
      vanity: '1-888-HELP-NOW',
      words: ['HELP', 'NOW'],
    });
    expect(typeof input.Item.vanityNumbers[0].score).toBe('number');
  });
});

describe('callers we cannot help', () => {
  it('handles a withheld caller ID with a spoken explanation, not an error', async () => {
    const response = await handler(connectEvent('anonymous'));

    expect(response.status).toBe('NO_CALLER_ID');
    expect(response.vanityCount).toBe('0');
    expect(response.message).toMatch(/caller I D/i);
    // Every failure path still gives the flow something to say.
    expect(response.vanitySpeechSsml.length).toBeGreaterThan(0);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('handles a missing CustomerEndpoint', async () => {
    const response = await handler(connectEvent(undefined));
    expect(response.status).toBe('NO_CALLER_ID');
  });

  it('tells international callers why, specifically', async () => {
    const response = await handler(connectEvent('+447700900123'));
    expect(response.status).toBe('UNSUPPORTED_NUMBER');
    expect(response.message).toMatch(/North American/i);
  });

  it('reports an unparseable number distinctly from an unsupported one', async () => {
    const response = await handler(connectEvent('12345'));
    expect(response.status).toBe('INVALID_NUMBER');
  });

  it('explains when a valid number simply spells nothing', async () => {
    const response = await handler(connectEvent('+13105550101'));
    expect(response.status).toBe('NO_VANITY');
    expect(response.message).toMatch(/zeros and ones/i);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('survives a completely empty event without throwing', async () => {
    const response = await handler({} as ConnectContactFlowEvent);
    expect(response.status).toBe('NO_CALLER_ID');
  });
});

describe('resilience', () => {
  it('still serves the caller when DynamoDB fails', async () => {
    mockSend.mockRejectedValue(new Error('ProvisionedThroughputExceededException'));

    const response = await handler(connectEvent('+18884357669'));

    // The whole point: a database problem must not become a bad phone call.
    expect(response.status).toBe('OK');
    expect(response.vanity1).toBe('1-888-HELP-NOW');
    expect(response.persisted).toBe('false');
  });

  it('logs the persistence failure at ERROR so the alarm fires', async () => {
    mockSend.mockRejectedValue(new Error('boom'));
    await handler(connectEvent('+18884357669'));

    const errorLines = (console.error as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]));
    const persistError = errorLines.find((line) =>
      String(line.msg).startsWith('Failed to persist call record'),
    );
    expect(persistError).toBeDefined();
    expect(persistError.level).toBe('ERROR');
  });

  it('fails fast and loudly on a misconfigured deployment', async () => {
    delete process.env.TABLE_NAME;
    __resetConfigForTests();
    await expect(handler(connectEvent('+18884357669'))).rejects.toThrow(
      /Missing required environment variable/,
    );
  });
});

describe('privacy', () => {
  it('never writes a full phone number to the logs', async () => {
    await handler(connectEvent('+18884357669'));

    const allOutput = [
      ...(console.log as jest.Mock).mock.calls,
      ...(console.warn as jest.Mock).mock.calls,
      ...(console.error as jest.Mock).mock.calls,
    ]
      .map((c) => String(c[0]))
      .join('\n');

    expect(allOutput).not.toContain('+18884357669');
    expect(allOutput).toContain('+1888***7669');
  });
});

describe('the phoneNumber test override', () => {
  it('lets a flow or a direct invoke exercise a specific number', async () => {
    const event = connectEvent('+13105550101');
    event.Details!.Parameters!.phoneNumber = '+18884357669';

    const response = await handler(event);
    expect(response.vanity1).toBe('1-888-HELP-NOW');
  });

  it('logs a warning whenever it is used, so it cannot be used quietly', async () => {
    const event = connectEvent('+13105550101');
    event.Details!.Parameters!.phoneNumber = '+18884357669';
    await handler(event);

    const warnings = (console.warn as jest.Mock).mock.calls.map((c) => JSON.parse(c[0]));
    expect(warnings.some((w) => String(w.msg).includes('phoneNumber override'))).toBe(true);
  });
});

describe('configurability', () => {
  it('honours RESULTS_TO_SPEAK', async () => {
    process.env.RESULTS_TO_SPEAK = '1';
    __resetConfigForTests();

    const response = await handler(connectEvent('+18884357669'));
    expect(response.vanityCount).toBe('1');
    expect(response.vanity2).toBeUndefined();
  });

  it('honours RESULTS_TO_STORE', async () => {
    process.env.RESULTS_TO_STORE = '2';
    __resetConfigForTests();

    await handler(connectEvent('+18884357669'));
    const { input } = mockSend.mock.calls[0][0];
    expect(input.Item.vanityNumbers).toHaveLength(2);
  });
});
