/**
 * Build-time generator for the vanity dictionary.
 *
 * Run with: npm run gen:dictionary
 *
 * WHY A BUILD STEP?
 * -----------------
 * The Lambda needs a word list, but pulling 36k words out of `wordlist-english`
 * at runtime means shipping that whole package (and its unused locales) into the
 * bundle. Generating a single pruned, pre-filtered JSON at build time keeps the
 * deployment artifact small, makes the dictionary reviewable in a code review
 * (it is committed), and makes the filtering rules explicit and testable.
 *
 * The generated file IS committed to git on purpose: the build is then
 * hermetic, and a reviewer can `cdk deploy` without needing the dev
 * dependencies or network access.
 *
 * PRODUCTION NOTE: at real scale I would move the dictionary out of the bundle
 * entirely -- an S3 object loaded on cold start (or a Lambda layer), versioned
 * and cache-busted via an env var. That lets word-list tuning ship without a
 * code deploy, and lets different tenants/locales use different dictionaries.
 */
import * as fs from 'fs';
import * as path from 'path';

/**
 * SCOWL size tiers, smallest (= most common) first. `wordlist-english` exposes
 * these as separate files; the tier a word first appears in is a decent, free
 * proxy for how well-known it is. We stop at 50: tiers 55-70 are dominated by
 * archaisms and inflected rarities ("zyzzyva"), which make for terrible vanity
 * numbers even though they are technically valid English.
 */
const TIERS = [10, 20, 35, 40, 50] as const;

/** Only 3-7 letter words. <3 is noise ("cat" is the shortest memorable unit);
 *  >7 cannot fit a NANP subscriber number. */
const MIN_LENGTH = 3;
const MAX_LENGTH = 7;

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'src', 'core', 'dictionary.generated.json');
const BLOCKLIST_FILE = path.join(__dirname, 'blocklist.txt');

function readBlocklist(): Set<string> {
  const raw = fs.readFileSync(BLOCKLIST_FILE, 'utf8');
  return new Set(
    raw
      .split(/\r?\n/)
      .map((l) => l.trim().toLowerCase())
      .filter((l) => l.length > 0 && !l.startsWith('#')),
  );
}

function loadTier(tier: number): string[] {
  // `english-*` is the shared core; `american-*` adds US spellings. We target
  // NANP numbers, so US spellings are the right variant to include.
  const files = [`english-words-${tier}.json`, `american-words-${tier}.json`];
  const words: string[] = [];
  for (const file of files) {
    const p = require.resolve(`wordlist-english/${file}`);
    words.push(...(JSON.parse(fs.readFileSync(p, 'utf8')) as string[]));
  }
  return words;
}

function main(): void {
  const blocklist = readBlocklist();
  const seen = new Set<string>();
  const tiers: Record<string, string[]> = {};

  let blocked = 0;

  for (const tier of TIERS) {
    const accepted: string[] = [];
    for (const raw of loadTier(tier)) {
      const word = raw.toLowerCase();
      // Reject anything with an apostrophe, hyphen, accent or digit: a vanity
      // number can only contain A-Z, so those words are unrepresentable anyway.
      if (!/^[a-z]+$/.test(word)) continue;
      if (word.length < MIN_LENGTH || word.length > MAX_LENGTH) continue;
      if (seen.has(word)) continue; // keep the *lowest* (most common) tier
      if (blocklist.has(word)) {
        blocked++;
        continue;
      }
      seen.add(word);
      accepted.push(word);
    }
    accepted.sort();
    tiers[String(tier)] = accepted;
  }

  const payload = {
    $schema: 'internal://vanity-dictionary/v1',
    source: 'wordlist-english@1.2.1 (SCOWL) - english + american variants',
    tiersIncluded: TIERS,
    minLength: MIN_LENGTH,
    maxLength: MAX_LENGTH,
    blockedCount: blocked,
    wordCount: seen.size,
    // Keyed by SCOWL tier. Lower tier == more common == better vanity number.
    tiers,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 0) + '\n', 'utf8');

  const bytes = fs.statSync(OUT_FILE).size;
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`  words:   ${seen.size}`);
  console.log(`  blocked: ${blocked}`);
  console.log(`  size:    ${(bytes / 1024).toFixed(1)} KiB`);
  for (const tier of TIERS) {
    console.log(`  tier ${String(tier).padStart(2)}: ${tiers[String(tier)].length}`);
  }
}

main();
