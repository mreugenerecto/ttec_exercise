import { scoreSegments, tierScore, WEIGHTS } from '../../src/core/score';
import { digitSegment, wordSegment, type Segment } from '../../src/core/segment';

const word = (text: string, tier = 10, start = 0): Segment => wordSegment(text, tier, start);
const digits = (text: string, start = 0): Segment => digitSegment(text, start);

describe('scoring weights', () => {
  it('sum to exactly 1 so the score is bounded to 0..100', () => {
    const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('never produces a score outside 0..100', () => {
    const best = scoreSegments([word('FLOWERS', 10)], 7);
    const worst = scoreSegments([digits('0'), word('ABC', 50, 1), digits('123', 4)], 7);
    for (const result of [best, worst]) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it('gives a perfect 100 to a single common word covering the whole number', () => {
    expect(scoreSegments([word('FLOWERS', 10)], 7).score).toBe(100);
  });
});

describe('the properties "best" is meant to capture', () => {
  it('prefers more letter coverage', () => {
    const more = scoreSegments([word('CAKES', 10), digits('27', 5)], 7);
    const less = scoreSegments([word('CAK', 10), digits('2273', 3)], 7);
    expect(more.score).toBeGreaterThan(less.score);
  });

  it('prefers one long word over two short ones at equal coverage', () => {
    const oneWord = scoreSegments([word('FLOWERS', 20)], 7);
    const twoWords = scoreSegments([word('FLOW', 20), word('ERS', 20, 4)], 7);
    expect(oneWord.score).toBeGreaterThan(twoWords.score);
  });

  it('prefers a number that ends on a word over one that ends on digits', () => {
    const anchored = scoreSegments([digits('22'), word('CAKE', 10, 2)], 6);
    const trailing = scoreSegments([word('CAKE', 10), digits('22', 4)], 6);
    expect(anchored.breakdown.tailAnchor).toBe(1);
    expect(trailing.breakdown.tailAnchor).toBe(0);
    expect(anchored.score).toBeGreaterThan(trailing.score);
  });

  it('prefers common words over obscure ones, all else equal', () => {
    const common = scoreSegments([word('FLOWERS', 10)], 7);
    const obscure = scoreSegments([word('FLOCCUS', 50)], 7);
    expect(common.score).toBeGreaterThan(obscure.score);
  });

  it('penalises fragmentation', () => {
    const whole = scoreSegments([word('PET', 10), word('CARE', 10, 3)], 7);
    const shattered = scoreSegments(
      [word('PET', 10), digits('2', 3), word('ARE', 10, 4), digits('7', 7)],
      8,
    );
    expect(whole.breakdown.fragmentation).toBeGreaterThan(shattered.breakdown.fragmentation);
  });
});

describe('edge cases', () => {
  it('scores an empty segmentation as zero rather than NaN', () => {
    const result = scoreSegments([], 7);
    expect(result.score).toBe(0);
    expect(Number.isNaN(result.score)).toBe(false);
  });

  it('does not divide by zero when there are no words', () => {
    const result = scoreSegments([digits('1234567')], 7);
    expect(result.breakdown.commonness).toBe(0);
    expect(Number.isFinite(result.score)).toBe(true);
  });

  it('does not divide by zero when totalDigits is zero', () => {
    expect(scoreSegments([word('CAT')], 0).score).toBe(0);
  });

  it('falls back to a conservative commonness for an unknown tier', () => {
    expect(tierScore(9999)).toBeLessThan(tierScore(50));
    expect(tierScore(10)).toBe(1);
  });
});
