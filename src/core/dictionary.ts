/**
 * The vanity dictionary: a digit-string -> words index.
 *
 * Built lazily on first use and cached for the life of the Lambda execution
 * environment, so the ~40 ms index build is paid once per cold start, not once
 * per call. Warm invocations do O(1) map lookups.
 */
import rawDictionary from './dictionary.generated.json';
import { wordToDigits } from './keypad';

export interface DictionaryWord {
  /** Uppercase, as it would be printed on a vanity number. */
  readonly word: string;
  /**
   * SCOWL size tier the word came from. Lower == more common == more memorable.
   * See `tools/build-dictionary.ts` for how this is derived.
   */
  readonly tier: number;
}

export interface DictionaryStats {
  readonly wordCount: number;
  readonly keyCount: number;
  readonly source: string;
}

interface RawDictionary {
  readonly source: string;
  readonly tiers: Record<string, string[]>;
}

let index: Map<string, DictionaryWord[]> | null = null;
let stats: DictionaryStats | null = null;

function build(): void {
  const data = rawDictionary as unknown as RawDictionary;
  const map = new Map<string, DictionaryWord[]>();
  let wordCount = 0;

  // Tiers are inserted in ascending (most-common-first) order, so each bucket is
  // already sorted by commonness. Downstream code relies on that: when several
  // words share a digit key we prefer the earliest.
  const tierKeys = Object.keys(data.tiers)
    .map(Number)
    .sort((a, b) => a - b);

  for (const tier of tierKeys) {
    for (const word of data.tiers[String(tier)]) {
      const digits = wordToDigits(word);
      // wordToDigits only returns null for non A-Z input, which the build tool
      // already excludes. Guard anyway so a bad dictionary degrades instead of
      // poisoning the index.
      if (digits === null) continue;
      const entry: DictionaryWord = { word: word.toUpperCase(), tier };
      const bucket = map.get(digits);
      if (bucket) bucket.push(entry);
      else map.set(digits, [entry]);
      wordCount++;
    }
  }

  index = map;
  stats = { wordCount, keyCount: map.size, source: data.source };
}

function ensureBuilt(): Map<string, DictionaryWord[]> {
  if (index === null) build();
  return index!;
}

/**
 * All dictionary words that dial as exactly `digits`.
 * Returns an empty array (never null) so callers can iterate unconditionally.
 */
export function lookup(digits: string): readonly DictionaryWord[] {
  return ensureBuilt().get(digits) ?? EMPTY;
}

/** True if any word dials as `digits`. Cheaper than `lookup().length > 0`. */
export function hasMatch(digits: string): boolean {
  return ensureBuilt().has(digits);
}

export function dictionaryStats(): DictionaryStats {
  ensureBuilt();
  return stats!;
}

/** Test seam: forces the next lookup to rebuild the index. */
export function __resetDictionaryForTests(): void {
  index = null;
  stats = null;
}

const EMPTY: readonly DictionaryWord[] = Object.freeze([]);
