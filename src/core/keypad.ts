/**
 * ITU E.161 / North American telephone keypad letter mapping.
 *
 * Note that 0 and 1 carry no letters. That is the single most important
 * constraint in this whole exercise: any 0 or 1 in the subscriber number is a
 * hard wall that a word cannot cross, which is why the generator below is a
 * segmentation problem rather than a simple dictionary lookup.
 */
export const DIGIT_TO_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  '0': '',
  '1': '',
  '2': 'ABC',
  '3': 'DEF',
  '4': 'GHI',
  '5': 'JKL',
  '6': 'MNO',
  '7': 'PQRS',
  '8': 'TUV',
  '9': 'WXYZ',
});

/** Inverse of DIGIT_TO_LETTERS, built once at module load. */
export const LETTER_TO_DIGIT: Readonly<Record<string, string>> = Object.freeze(
  Object.entries(DIGIT_TO_LETTERS).reduce<Record<string, string>>((acc, [digit, letters]) => {
    for (const letter of letters) acc[letter] = digit;
    return acc;
  }, {}),
);

/**
 * Convert a word to the digit sequence a caller would dial for it.
 *
 * @returns the digit string, or `null` if the word contains a character with no
 *          keypad representation. Returning null rather than throwing keeps the
 *          hot path (23k dictionary words) branch-free of exception handling.
 */
export function wordToDigits(word: string): string | null {
  let out = '';
  for (const ch of word.toUpperCase()) {
    const digit = LETTER_TO_DIGIT[ch];
    if (digit === undefined) return null;
    out += digit;
  }
  return out;
}

/** True if `word` can be dialled as exactly `digits`. */
export function wordMatchesDigits(word: string, digits: string): boolean {
  return wordToDigits(word) === digits;
}
