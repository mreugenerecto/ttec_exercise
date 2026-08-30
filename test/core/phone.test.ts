import { formatNanp, parsePhoneNumber, redactPhone } from '../../src/core/phone';

/** Small helper so the happy-path assertions stay readable. */
function parseOk(raw: string) {
  const result = parsePhoneNumber(raw);
  if (!result.ok) throw new Error(`expected ${raw} to parse, got ${result.reason}`);
  return result.phone;
}

describe('parsePhoneNumber', () => {
  it.each([
    '+15552345678',
    '15552345678',
    '5552345678',
    '+1 (555) 234-5678',
    '555.234.5678',
    '  +1-555-234-5678  ',
    'tel:+15552345678',
  ])('accepts %s and normalises to E.164', (raw) => {
    expect(parseOk(raw).e164).toBe('+15552345678');
  });

  it('rejects the classic fictional 555-123-4567, and that is correct', () => {
    // NANP exchange codes (the NXX) cannot begin with 0 or 1, so this number is
    // structurally invalid however familiar it looks. Being strict here is
    // deliberate: a caller ID that cannot exist is more likely to be spoofed or
    // mangled by a carrier than to be a real customer.
    expect(parsePhoneNumber('+15551234567')).toEqual({ ok: false, reason: 'MALFORMED' });
  });

  it('splits out the area code and subscriber number', () => {
    const phone = parseOk('+18884357669');
    expect(phone.areaCode).toBe('888');
    expect(phone.subscriber).toBe('4357669');
  });

  describe('rejections', () => {
    it.each([
      [null, 'MISSING'],
      [undefined, 'MISSING'],
      ['', 'MISSING'],
      ['   ', 'MISSING'],
    ])('reports %s as MISSING', (raw, reason) => {
      const result = parsePhoneNumber(raw as string | null | undefined);
      expect(result).toEqual({ ok: false, reason });
    });

    it.each(['anonymous', 'ANONYMOUS', 'unknown', 'Private', 'restricted', 'withheld'])(
      'reports withheld caller ID "%s" as ANONYMOUS',
      (raw) => {
        expect(parsePhoneNumber(raw)).toEqual({ ok: false, reason: 'ANONYMOUS' });
      },
    );

    it('distinguishes a real foreign number from garbage', () => {
      // A UK mobile: valid, just not something a keypad-letter service handles.
      expect(parsePhoneNumber('+447700900123')).toEqual({ ok: false, reason: 'NOT_NANP' });
      expect(parsePhoneNumber('+861380013800')).toEqual({ ok: false, reason: 'NOT_NANP' });
    });

    it.each([
      ['123', 'MALFORMED'],
      ['not-a-phone-number', 'MALFORMED'],
      ['555123456', 'MALFORMED'], // 9 digits
      ['0551234567', 'MALFORMED'], // NANP area codes cannot start with 0
      ['1551234567', 'MALFORMED'], // ... or 1
      ['5550234567', 'MALFORMED'], // ... and neither can the exchange code
    ])('reports %s as %s', (raw, reason) => {
      expect(parsePhoneNumber(raw)).toEqual({ ok: false, reason });
    });

    it('does not silently accept an 11-digit number with the wrong country code', () => {
      // 2 is not a valid NANP country code, so this is 11 digits of something else.
      expect(parsePhoneNumber('+25551234567').ok).toBe(false);
    });
  });
});

describe('redactPhone', () => {
  it('keeps the last four digits and the country/area prefix', () => {
    expect(redactPhone('+15551234567')).toBe('+1555***4567');
  });

  it('never returns the full number for realistic inputs', () => {
    const original = '+18884357669';
    expect(redactPhone(original)).not.toContain('4357');
    expect(redactPhone(original)).toContain('7669');
  });

  it('handles absent and very short values without throwing', () => {
    expect(redactPhone(null)).toBe('<none>');
    expect(redactPhone(undefined)).toBe('<none>');
    expect(redactPhone('')).toBe('<none>');
    expect(redactPhone('12')).toBe('***');
  });
});

describe('formatNanp', () => {
  it('formats the way a person would read it aloud', () => {
    expect(formatNanp(parseOk('+18884357669'))).toBe('(888) 435-7669');
  });
});
