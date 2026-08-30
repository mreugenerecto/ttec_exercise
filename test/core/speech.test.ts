import { buildVanitySpeech, escapeXml, vanityToPlainSpeech, vanityToSsml } from '../../src/core/speech';
import type { VanityCandidate } from '../../src/core/vanity';

const candidate = (vanity: string, score = 90): VanityCandidate => ({
  vanity,
  pattern: vanity.split('-').slice(2).join('-'),
  words: vanity.split('-').filter((t) => /^[A-Z]+$/.test(t)),
  score,
  breakdown: { coverage: 1, longestWord: 1, fragmentation: 1, tailAnchor: 1, commonness: 1 },
});

describe('escapeXml', () => {
  it('escapes all five XML entities', () => {
    expect(escapeXml(`<a href="x">&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&apos;&lt;/a&gt;',
    );
  });

  it('escapes ampersands before the entities it introduces', () => {
    // Naive sequential replacement double-escapes; this guards against that.
    expect(escapeXml('&lt;')).toBe('&amp;lt;');
  });
});

describe('vanityToSsml', () => {
  it('reads letter runs as characters and digit runs as digits', () => {
    const ssml = vanityToSsml('1-888-HELP-NOW');
    expect(ssml).toContain('<say-as interpret-as="digits">1</say-as>');
    expect(ssml).toContain('<say-as interpret-as="digits">888</say-as>');
    expect(ssml).toContain('<say-as interpret-as="characters">HELP</say-as>');
    expect(ssml).toContain('<say-as interpret-as="characters">NOW</say-as>');
  });

  it('does not wrap the fragment in <speak> -- Amazon Connect adds that itself', () => {
    expect(vanityToSsml('1-888-HELP-NOW')).not.toContain('<speak>');
  });

  it('produces balanced tags', () => {
    const ssml = vanityToSsml('1-555-CAKE-227');
    const opens = (ssml.match(/<say-as /g) ?? []).length;
    const closes = (ssml.match(/<\/say-as>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it('ignores empty tokens from stray hyphens', () => {
    const ssml = vanityToSsml('1--888');
    expect((ssml.match(/<say-as /g) ?? []).length).toBe(2);
    expect(ssml).not.toContain('></say-as>');
  });
});

describe('vanityToPlainSpeech', () => {
  it('spaces characters out so Polly reads them individually', () => {
    expect(vanityToPlainSpeech('1-888-HELP')).toBe('1, 8 8 8, H E L P');
  });
});

describe('buildVanitySpeech', () => {
  it('numbers each option and pauses between them', () => {
    const speech = buildVanitySpeech([candidate('1-888-HELP-NOW'), candidate('1-888-HELP-MOW')]);
    expect(speech.ssml).toContain('Option one.');
    expect(speech.ssml).toContain('Option two.');
    expect(speech.ssml).toContain('<break time="700ms"/>');
    expect(speech.text).toContain('Option one.');
  });

  it('uses singular phrasing for a single result', () => {
    const speech = buildVanitySpeech([candidate('1-888-HELP-NOW')]);
    expect(speech.ssml).toContain('Here is the best vanity number');
  });

  it('explains itself when there is nothing to say', () => {
    const speech = buildVanitySpeech([]);
    expect(speech.ssml).toContain('could not find any vanity numbers');
    expect(speech.ssml).not.toContain('<say-as');
    expect(speech.text).toBe(speech.ssml);
  });

  it('honours a custom pause length', () => {
    const speech = buildVanitySpeech([candidate('1-888-HELP-NOW')], { pauseMs: 250 });
    expect(speech.ssml).toContain('<break time="250ms"/>');
  });
});
