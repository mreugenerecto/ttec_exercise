/**
 * How "best" is defined.
 * =====================
 *
 * The brief says: save the *best* 5 vanity numbers, "best" is mine to define.
 * A vanity number exists for exactly one reason -- so a human hears it once on
 * the radio and can still dial it an hour later. So I scored candidates on
 * *memorability*, not on cleverness, and broke that into five measurable parts.
 *
 * Every weight below is a judgement call, and every one of them is a named
 * constant so it can be argued about, A/B tested, and changed without touching
 * the generator. That separation is the actual design decision; the specific
 * numbers are just my starting point.
 *
 *   1. COVERAGE (0.35) -- what fraction of the 7 subscriber digits are inside a
 *      real word. "555-CAKES" (5 of 7 as letters) beats "555-CAT-89". This gets
 *      the largest weight because leftover digits are the thing people forget.
 *
 *   2. LONGEST WORD (0.20) -- one long word is easier to hold in memory than the
 *      same coverage split across two. A full 7-letter cover (1-800-FLOWERS) is
 *      the jackpot and this term is what makes it win.
 *
 *   3. FRAGMENTATION (0.15) -- penalty per extra token. "PET-CARE" is fine;
 *      "PET-C-4-RE" is unsayable. Coverage alone would happily reward the
 *      latter, so this term exists to stop it.
 *
 *   4. TAIL ANCHOR (0.15) -- a bonus when the number *ends* on a word. This is
 *      how every real vanity number is built (1-800-FLOWERS, 1-800-GOT-JUNK):
 *      the prefix is routing the caller already ignores, and the payload lands
 *      last where it is remembered. A trailing digit run undoes that.
 *
 *   5. COMMONNESS (0.15) -- prefer words people actually know. Derived from the
 *      SCOWL size tier the word came from (see tools/build-dictionary.ts).
 *      "FLOWERS" should beat "FLOCCUS" at identical coverage.
 *
 * WHAT I DELIBERATELY DID NOT SCORE, and would add with more time:
 *   - Phonetic ease (consonant clusters, syllable count) via a CMU-dict style
 *     pronunciation lexicon. "SCHRSTS" is a legal word shape and a terrible
 *     phone number.
 *   - Semantic fit to the *business* -- the single biggest real-world lever. A
 *     florist wants FLOWERS even if PLOUGHS scores higher. In production this
 *     would be a per-tenant boosted term list, and I would expose it as
 *     configuration on the DynamoDB tenant record.
 *   - Observed dial-through rate. The honest version of "best" is measured, not
 *     asserted: log which option callers actually redial and learn the weights.
 */
import type { Segment } from './segment';

/** Scoring weights. Must sum to 1 so the final score lands in 0..100. */
export const WEIGHTS = Object.freeze({
  coverage: 0.35,
  longestWord: 0.2,
  fragmentation: 0.15,
  tailAnchor: 0.15,
  commonness: 0.15,
});

/**
 * SCOWL tier -> commonness score in 0..1.
 * Non-linear on purpose: the gap between "everyday" and "recognisable" matters
 * more than the gap between "obscure" and "very obscure".
 */
const TIER_SCORE: Readonly<Record<number, number>> = Object.freeze({
  10: 1.0,
  20: 0.9,
  35: 0.75,
  40: 0.65,
  50: 0.5,
});

/** Fallback for a tier we do not recognise -- treat unknown as fairly obscure. */
const UNKNOWN_TIER_SCORE = 0.4;

export function tierScore(tier: number): number {
  return TIER_SCORE[tier] ?? UNKNOWN_TIER_SCORE;
}

/** The individual 0..1 components, exposed so the API and tests can explain a score. */
export interface ScoreBreakdown {
  readonly coverage: number;
  readonly longestWord: number;
  readonly fragmentation: number;
  readonly tailAnchor: number;
  readonly commonness: number;
}

export interface ScoreResult {
  /** 0..100, rounded to 1 decimal place for stable comparison and display. */
  readonly score: number;
  readonly breakdown: ScoreBreakdown;
}

/**
 * Score one candidate segmentation of the subscriber number.
 *
 * @param segments  the candidate, left to right.
 * @param totalDigits  length of the digit string being segmented (7 for NANP).
 */
export function scoreSegments(segments: readonly Segment[], totalDigits: number): ScoreResult {
  if (segments.length === 0 || totalDigits <= 0) {
    return {
      score: 0,
      breakdown: { coverage: 0, longestWord: 0, fragmentation: 0, tailAnchor: 0, commonness: 0 },
    };
  }

  let letterDigits = 0;
  let longest = 0;
  let tierTotal = 0;
  let wordCount = 0;

  for (const segment of segments) {
    if (segment.kind !== 'word') continue;
    letterDigits += segment.text.length;
    longest = Math.max(longest, segment.text.length);
    tierTotal += tierScore(segment.tier);
    wordCount++;
  }

  const coverage = letterDigits / totalDigits;
  const longestWord = longest / totalDigits;

  // Fragmentation: 1 token is perfect, `totalDigits` tokens (all literal digits)
  // is the worst case. Guard the denominator for a 1-digit input.
  const maxExtraTokens = Math.max(1, totalDigits - 1);
  const fragmentation = 1 - Math.min(1, (segments.length - 1) / maxExtraTokens);

  const tailAnchor = segments[segments.length - 1].kind === 'word' ? 1 : 0;

  // Mean commonness over the words present. A candidate with no words scores 0
  // here rather than dividing by zero -- and it will already have lost on
  // coverage anyway.
  const commonness = wordCount === 0 ? 0 : tierTotal / wordCount;

  const breakdown: ScoreBreakdown = { coverage, longestWord, fragmentation, tailAnchor, commonness };

  const score =
    100 *
    (WEIGHTS.coverage * coverage +
      WEIGHTS.longestWord * longestWord +
      WEIGHTS.fragmentation * fragmentation +
      WEIGHTS.tailAnchor * tailAnchor +
      WEIGHTS.commonness * commonness);

  return { score: Math.round(score * 10) / 10, breakdown };
}
