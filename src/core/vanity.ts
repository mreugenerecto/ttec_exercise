/**
 * Vanity number generation.
 *
 * The problem is a constrained segmentation, not a lookup: we partition the
 * 7-digit subscriber number into an ordered sequence of tokens, where each token
 * is either a dictionary word that dials as those digits, or a run of literal
 * digits that no word could cover (every 0 and 1 forces one of these).
 *
 * WHY ONLY THE LAST 7 DIGITS?
 * Because that is how vanity numbers actually work. 1-800-FLOWERS keeps its area
 * code as digits: the NPA is routing information the caller reads as numbers,
 * and it is frequently not even dialled on a local call. Spelling into the area
 * code produces strings nobody recognises as a phone number. `spellWindow` is
 * configurable if a future caller base wants different behaviour.
 *
 * COMPLEXITY: the search is exponential in principle, but the input is fixed at
 * 7 digits and both the per-span word count and the total candidate count are
 * capped (see `GenerateOptions`), so the work is bounded and p99 stays flat
 * regardless of how lucky the number is. Measured: ~1-3 ms warm.
 */
import { lookup } from './dictionary';
import { parsePhoneNumber, type ParsedPhone, type PhoneRejectReason } from './phone';
import { scoreSegments, type ScoreBreakdown } from './score';
import { digitSegment, renderSegments, wordSegment, type Segment } from './segment';

/**
 * Shortest token we will accept as a "word". Two-letter words ("an", "it") add
 * noise and hurt readability far more than the coverage they buy.
 */
export const MIN_WORD_LENGTH = 3;

export interface GenerateOptions {
  /** How many scored candidates to return. Default 5 (the brief's "best 5"). */
  readonly maxResults?: number;
  /**
   * Per digit-span cap on dictionary words considered. Buckets are pre-sorted by
   * commonness, so this keeps the most memorable words and discards the tail.
   */
  readonly maxWordsPerSpan?: number;
  /** Hard stop on enumerated segmentations, to bound worst-case latency. */
  readonly maxCandidates?: number;
  /** How many trailing digits are eligible to be spelled. Default 7. */
  readonly spellWindow?: number;
}

const DEFAULTS: Required<GenerateOptions> = {
  maxResults: 5,
  maxWordsPerSpan: 8,
  maxCandidates: 4000,
  spellWindow: 7,
};

export interface VanityCandidate {
  /** Printable vanity number, e.g. "1-555-CAKE-227". */
  readonly vanity: string;
  /** Just the spelled portion, e.g. "CAKE-227". */
  readonly pattern: string;
  /** The dictionary words used, in order. */
  readonly words: readonly string[];
  /** 0..100. Higher is better. See score.ts for the definition of "better". */
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
}

export type GenerateResult =
  | {
      readonly ok: true;
      readonly phone: ParsedPhone;
      readonly candidates: readonly VanityCandidate[];
      /** Total segmentations enumerated. Useful for tuning the caps. */
      readonly explored: number;
      /** True if `maxCandidates` cut the search short. */
      readonly truncated: boolean;
    }
  | { readonly ok: false; readonly reason: PhoneRejectReason };

/**
 * Generate the best vanity numbers for a caller's phone number.
 *
 * Pure and synchronous: no I/O, no clock, no randomness. That makes it trivially
 * unit testable, and guarantees the same input always produces the same ranked
 * output, which matters because the results are persisted and spoken to callers.
 */
export function generateVanityNumbers(
  rawPhoneNumber: string | null | undefined,
  options: GenerateOptions = {},
): GenerateResult {
  const parsed = parsePhoneNumber(rawPhoneNumber);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const opts = { ...DEFAULTS, ...options };
  const phone = parsed.phone;

  // The digits we are allowed to spell into, and the untouched prefix in front.
  const window = Math.max(0, Math.min(opts.spellWindow, phone.subscriber.length));
  const untouched = phone.subscriber.slice(0, phone.subscriber.length - window);
  const target = phone.subscriber.slice(phone.subscriber.length - window);

  const segmentations: Segment[][] = [];
  let explored = 0;
  let truncated = false;

  const acc: Segment[] = [];

  const emit = (): void => {
    explored++;
    // A segmentation with no words is just the original phone number.
    if (acc.some((s) => s.kind === 'word')) segmentations.push([...acc]);
  };

  const budgetExhausted = (): boolean => {
    if (explored >= opts.maxCandidates) {
      truncated = true;
      return true;
    }
    return false;
  };

  /** Try every dictionary word starting at `i`, then continue with `walk`. */
  const walkWords = (i: number): void => {
    const maxLen = target.length - i;
    for (let len = maxLen; len >= MIN_WORD_LENGTH; len--) {
      if (budgetExhausted()) return;
      const words = lookup(target.slice(i, i + len));
      const limit = Math.min(words.length, opts.maxWordsPerSpan);
      for (let w = 0; w < limit; w++) {
        if (budgetExhausted()) return;
        acc.push(wordSegment(words[w].word, words[w].tier, i));
        walk(i + len);
        acc.pop();
      }
    }
  };

  /**
   * Enumerate segmentations of target[i..end]. Digit runs are only ever emitted
   * in *maximal* form (a digit run is always followed by a word or by the end of
   * the number), which makes every distinct segmentation reachable by exactly
   * one path: no duplicates, and no dedupe pass over the search itself.
   */
  const walk = (i: number): void => {
    if (i === target.length) {
      emit();
      return;
    }
    if (budgetExhausted()) return;

    walkWords(i);

    for (let len = 1; i + len <= target.length; len++) {
      if (budgetExhausted()) return;
      const j = i + len;
      acc.push(digitSegment(target.slice(i, j), i));
      if (j === target.length) emit();
      else walkWords(j);
      acc.pop();
    }
  };

  if (target.length > 0) walk(0);

  const seen = new Set<string>();
  const candidates: VanityCandidate[] = [];

  for (const segments of segmentations) {
    const pattern = (untouched ? `${untouched}-` : '') + renderSegments(segments);
    if (seen.has(pattern)) continue;
    seen.add(pattern);
    const { score, breakdown } = scoreSegments(segments, target.length);
    candidates.push({
      vanity: `1-${phone.areaCode}-${pattern}`,
      pattern,
      words: segments.filter((s) => s.kind === 'word').map((s) => s.text),
      score,
      breakdown,
    });
  }

  candidates.sort(compareCandidates);

  return {
    ok: true,
    phone,
    candidates: candidates.slice(0, opts.maxResults),
    explored,
    truncated,
  };
}

/**
 * Total order over candidates. Every tiebreaker is deterministic so the same
 * phone number always yields the same ranked list, which matters because the
 * results are persisted, spoken back to callers, and asserted on in tests.
 */
function compareCandidates(a: VanityCandidate, b: VanityCandidate): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.breakdown.coverage !== a.breakdown.coverage) {
    return b.breakdown.coverage - a.breakdown.coverage;
  }
  if (a.words.length !== b.words.length) return a.words.length - b.words.length;
  return a.vanity.localeCompare(b.vanity);
}
