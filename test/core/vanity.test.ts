import { dictionaryStats } from '../../src/core/dictionary';
import { wordToDigits } from '../../src/core/keypad';
import { generateVanityNumbers, MIN_WORD_LENGTH } from '../../src/core/vanity';

function generateOk(raw: string, options = {}) {
  const result = generateVanityNumbers(raw, options);
  if (!result.ok) throw new Error(`expected ${raw} to generate, got ${result.reason}`);
  return result;
}

describe('dictionary', () => {
  it('loaded a substantial word list', () => {
    const stats = dictionaryStats();
    expect(stats.wordCount).toBeGreaterThan(15000);
    expect(stats.keyCount).toBeGreaterThan(10000);
  });
});

describe('generateVanityNumbers', () => {
  it('finds the obvious answer for a number that spells one', () => {
    // 435-7669 dials HELP-NOW.
    const result = generateOk('+18884357669');
    expect(result.candidates[0].vanity).toBe('1-888-HELP-NOW');
  });

  it('returns five results by default, as the brief asks', () => {
    expect(generateOk('+18884357669').candidates).toHaveLength(5);
  });

  it('honours maxResults', () => {
    expect(generateOk('+18884357669', { maxResults: 3 }).candidates).toHaveLength(3);
  });

  it('leaves the area code untouched and only spells the subscriber number', () => {
    const result = generateOk('+12125552253');
    for (const candidate of result.candidates) {
      expect(candidate.vanity.startsWith('1-212-')).toBe(true);
    }
  });

  it('produces candidates whose letters really dial back to the original number', () => {
    const result = generateOk('+18884357669');
    for (const candidate of result.candidates) {
      const dialled = candidate.pattern
        .split('-')
        .map((token) => (/^\d+$/.test(token) ? token : wordToDigits(token)))
        .join('');
      expect(dialled).toBe(result.phone.subscriber);
    }
  });

  it('ranks results in descending score order', () => {
    const scores = generateOk('+18884357669').candidates.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('never emits a candidate with no words -- that would just be the phone number', () => {
    const result = generateOk('+18884357669');
    for (const candidate of result.candidates) {
      expect(candidate.words.length).toBeGreaterThan(0);
    }
  });

  it('never emits a word shorter than the minimum', () => {
    const result = generateOk('+15552253784');
    for (const candidate of result.candidates) {
      for (const w of candidate.words) {
        expect(w.length).toBeGreaterThanOrEqual(MIN_WORD_LENGTH);
      }
    }
  });

  it('returns no candidates for a number full of 0s and 1s', () => {
    // 555-0101 has no letters on 0 or 1, so nothing can be spelled.
    const result = generateOk('+13105550101');
    expect(result.candidates).toHaveLength(0);
  });

  it('is deterministic: the same number always yields the same ranked list', () => {
    const first = generateOk('+15552253784').candidates.map((c) => c.vanity);
    const second = generateOk('+15552253784').candidates.map((c) => c.vanity);
    expect(first).toEqual(second);
  });

  it('never returns duplicate vanity strings', () => {
    const vanities = generateOk('+18002253784', { maxResults: 25 }).candidates.map((c) => c.vanity);
    expect(new Set(vanities).size).toBe(vanities.length);
  });

  describe('rejected inputs are passed through, not swallowed', () => {
    it.each([
      ['anonymous', 'ANONYMOUS'],
      ['', 'MISSING'],
      ['+447700900123', 'NOT_NANP'],
      ['nonsense', 'MALFORMED'],
    ])('%s -> %s', (raw, reason) => {
      expect(generateVanityNumbers(raw)).toEqual({ ok: false, reason });
    });
  });

  describe('bounded work', () => {
    it('stays under the candidate budget even for a letter-rich number', () => {
      // 222-2222 is the densest possible input: every digit maps to A, B or C.
      const result = generateOk('+18002222222', { maxCandidates: 500, maxResults: 5 });
      expect(result.explored).toBeLessThanOrEqual(500);
      expect(result.candidates.length).toBeGreaterThan(0);
    });

    it('reports when the search was truncated instead of pretending it was exhaustive', () => {
      const result = generateOk('+18002222222', { maxCandidates: 20 });
      expect(result.truncated).toBe(true);
    });

    it('completes a worst-case number quickly', () => {
      const started = Date.now();
      generateOk('+18002222222');
      // Generous bound: this is a regression guard against an accidental
      // exponential blow-up, not a benchmark. Warm runs are 1-3 ms.
      expect(Date.now() - started).toBeLessThan(1000);
    });
  });

  describe('spellWindow', () => {
    it('can be narrowed to spell only the last four digits', () => {
      const result = generateOk('+18884357669', { spellWindow: 4 });
      for (const candidate of result.candidates) {
        // The first three subscriber digits stay literal.
        expect(candidate.pattern.startsWith('435-')).toBe(true);
      }
    });
  });
});
