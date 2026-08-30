import { DIGIT_TO_LETTERS, LETTER_TO_DIGIT, wordMatchesDigits, wordToDigits } from '../../src/core/keypad';

describe('keypad', () => {
  it('maps every letter of the alphabet exactly once', () => {
    const letters = Object.keys(LETTER_TO_DIGIT).sort().join('');
    expect(letters).toBe('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  });

  it('leaves 0 and 1 with no letters, which is what forces digit runs', () => {
    expect(DIGIT_TO_LETTERS['0']).toBe('');
    expect(DIGIT_TO_LETTERS['1']).toBe('');
  });

  it.each([
    ['FLOWERS', '3569377'],
    ['HELP', '4357'],
    ['CAKE', '2253'],
    ['now', '669'],
  ])('converts %s to %s', (word, digits) => {
    expect(wordToDigits(word)).toBe(digits);
  });

  it('is case insensitive', () => {
    expect(wordToDigits('help')).toBe(wordToDigits('HELP'));
  });

  it('returns null for characters with no keypad representation', () => {
    expect(wordToDigits("o'clock")).toBeNull();
    expect(wordToDigits('co-op')).toBeNull();
    expect(wordToDigits('café')).toBeNull();
  });

  it('treats the empty string as the empty digit sequence', () => {
    expect(wordToDigits('')).toBe('');
  });

  it('confirms a word dials as a given digit string', () => {
    expect(wordMatchesDigits('HELP', '4357')).toBe(true);
    expect(wordMatchesDigits('HELP', '4358')).toBe(false);
    // Different words can share digits -- that is the whole point of the exercise.
    expect(wordToDigits('GIFT')).toBe(wordToDigits('HIFT'));
  });
});
