/**
 * Phone number parsing, narrowly scoped to what this service actually needs.
 *
 * DELIBERATE NON-USE OF A LIBRARY: `libphonenumber-js` is the correct answer for
 * general phone parsing, but it adds ~150 KiB to a Lambda whose entire job is
 * "is this a 10-digit NANP number, and what are the last 7 digits?". The
 * validation surface here is small enough to own and unit test. If this service
 * ever needed to reason about non-NANP numbering plans, extensions, or
 * formatting for display in many locales, I would swap this file for
 * libphonenumber-js immediately -- the `ParsedPhone` type is the seam for that.
 */

/** Reasons a caller's number cannot be turned into vanity numbers. */
export type PhoneRejectReason =
  | 'MISSING' // no caller ID at all (Connect sends "" or undefined)
  | 'ANONYMOUS' // caller withheld their number
  | 'NOT_NANP' // valid number, but not +1 -- keypad letters are a NANP convention
  | 'MALFORMED'; // could not be understood as a phone number

export interface ParsedPhone {
  /** Full number in E.164, e.g. "+15551234567". */
  readonly e164: string;
  /** NANP area code (NPA), e.g. "555". */
  readonly areaCode: string;
  /** The 7-digit subscriber number (NXX-XXXX), e.g. "1234567". */
  readonly subscriber: string;
}

export type ParsePhoneResult =
  | { readonly ok: true; readonly phone: ParsedPhone }
  | { readonly ok: false; readonly reason: PhoneRejectReason };

/** Values Amazon Connect uses when caller ID is unavailable or suppressed. */
const ANONYMOUS_TOKENS = new Set(['anonymous', 'unknown', 'private', 'restricted', 'withheld']);

/**
 * Parse a caller number into its NANP parts.
 *
 * Accepts the shapes Connect and humans actually produce:
 *   "+15551234567", "15551234567", "5551234567",
 *   "+1 (555) 123-4567", "555.123.4567", "tel:+15551234567"
 */
export function parsePhoneNumber(raw: string | null | undefined): ParsePhoneResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'MISSING' };

  const trimmed = String(raw).trim();
  if (trimmed.length === 0) return { ok: false, reason: 'MISSING' };
  if (ANONYMOUS_TOKENS.has(trimmed.toLowerCase())) return { ok: false, reason: 'ANONYMOUS' };

  // Strip a `tel:` URI prefix, then everything that is not a digit or a leading +.
  const withoutScheme = trimmed.replace(/^tel:/i, '');
  const hadPlus = withoutScheme.startsWith('+');
  const digits = withoutScheme.replace(/\D/g, '');

  if (digits.length === 0) return { ok: false, reason: 'MALFORMED' };

  let national: string;
  if (digits.length === 11 && digits.startsWith('1')) {
    national = digits.slice(1);
  } else if (digits.length === 10 && !hadPlus) {
    // A bare 10-digit number is unambiguously NANP national format.
    national = digits;
  } else if (hadPlus) {
    // An explicit + on anything that is not +1XXXXXXXXXX is a real number from
    // another country -- distinguish that from garbage so the IVR can say
    // something useful instead of "sorry, something went wrong".
    return { ok: false, reason: 'NOT_NANP' };
  } else {
    return { ok: false, reason: digits.length > 11 ? 'NOT_NANP' : 'MALFORMED' };
  }

  // NANP structure: NPA and NXX both start 2-9. This rejects test junk like
  // 0000000000 that would otherwise produce a "vanity number" of all digits.
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(national)) {
    return { ok: false, reason: 'MALFORMED' };
  }

  return {
    ok: true,
    phone: {
      e164: `+1${national}`,
      areaCode: national.slice(0, 3),
      subscriber: national.slice(3),
    },
  };
}

/**
 * Redact a phone number for logging: keep enough to correlate a support ticket,
 * drop enough that CloudWatch Logs is not a PII store.
 * "+15551234567" -> "+1555***4567"
 */
export function redactPhone(value: string | null | undefined): string {
  if (!value) return '<none>';
  const s = String(value);
  if (s.length <= 4) return '***';
  return `${s.slice(0, Math.max(0, s.length - 7))}***${s.slice(-4)}`;
}

/** Format a NANP number the way a human would read it: "(555) 123-4567". */
export function formatNanp(phone: ParsedPhone): string {
  return `(${phone.areaCode}) ${phone.subscriber.slice(0, 3)}-${phone.subscriber.slice(3)}`;
}
