/**
 * Turning vanity numbers into something Amazon Polly reads correctly.
 *
 * This is less trivial than it looks. Handed the plain string "1-888-HELP-NOW",
 * Polly says "one, eight hundred eighty eight, help now" -- it reads the words
 * as words and the digits as a cardinal number, which is useless to a caller
 * trying to write a phone number down. The fix is SSML: `interpret-as="digits"`
 * for numeric runs and `interpret-as="characters"` for letter runs, so the
 * caller hears "eight-eight-eight, H-E-L-P, N-O-W".
 *
 * Both an SSML and a plain-text rendering are produced. The contact flow uses
 * the SSML one; the plain-text one exists because SSML is a per-prompt setting
 * that is easy to get wrong when editing a flow in the console, and a silently
 * mangled prompt is worse than a slightly robotic one.
 */
import type { VanityCandidate } from './vanity';

/** Escape the five XML entities. Vanity output is A-Z and 0-9 only, so this is
 *  belt-and-braces -- but SSML is markup, and unescaped user-derived data going
 *  into markup is how injection bugs start. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Render one hyphen-separated vanity number ("1-888-HELP-NOW") as SSML. */
export function vanityToSsml(vanity: string): string {
  return vanity
    .split('-')
    .filter((token) => token.length > 0)
    .map((token) => {
      const interpretAs = /^\d+$/.test(token) ? 'digits' : 'characters';
      return `<say-as interpret-as="${interpretAs}">${escapeXml(token)}</say-as>`;
    })
    .join('<break time="250ms"/>');
}

/** Plain-text fallback: letters spaced out so Polly reads them individually. */
export function vanityToPlainSpeech(vanity: string): string {
  return vanity
    .split('-')
    .filter((token) => token.length > 0)
    .map((token) => token.split('').join(' '))
    .join(', ');
}

export interface SpeechOptions {
  /** Pause between options, in milliseconds. Long enough to write one down. */
  readonly pauseMs?: number;
}

/**
 * Build the full prompt the IVR speaks.
 *
 * @returns `{ ssml, text }`. Neither is wrapped in `<speak>` -- Amazon Connect
 *          adds those tags itself when a prompt is set to interpret as SSML, and
 *          a nested `<speak>` is a hard error at synthesis time.
 */
export function buildVanitySpeech(
  candidates: readonly VanityCandidate[],
  options: SpeechOptions = {},
): { ssml: string; text: string } {
  const pauseMs = options.pauseMs ?? 700;

  if (candidates.length === 0) {
    const message =
      'Sorry, we could not find any vanity numbers for your phone number. ' +
      'Numbers containing zeros and ones have very few letter combinations.';
    return { ssml: escapeXml(message), text: message };
  }

  const intro =
    candidates.length === 1
      ? 'Here is the best vanity number for your phone number.'
      : `Here are the top ${numberWord(candidates.length)} vanity numbers for your phone number.`;

  const ssmlParts: string[] = [escapeXml(intro), `<break time="${pauseMs}ms"/>`];
  const textParts: string[] = [intro];

  candidates.forEach((candidate, i) => {
    const label = `Option ${numberWord(i + 1)}.`;
    ssmlParts.push(escapeXml(label), vanityToSsml(candidate.vanity), `<break time="${pauseMs}ms"/>`);
    textParts.push(`${label} ${vanityToPlainSpeech(candidate.vanity)}.`);
  });

  return { ssml: ssmlParts.join(' '), text: textParts.join(' ') };
}

/** Polly reads "1." as "one" fine, but spelling it removes any ambiguity with
 *  the digits being read back immediately afterwards. */
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function numberWord(n: number): string {
  return NUMBER_WORDS[n] ?? String(n);
}
