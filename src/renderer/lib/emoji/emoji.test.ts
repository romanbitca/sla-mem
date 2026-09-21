import { beforeAll, describe, expect, it } from 'vitest';
import { emojiFromShortcode, isEmojiMapLoaded, loadEmojiMap, splitShortcode } from './index';
import { applySkinTone, buildEmojiTable, type EmojiMapData } from './table';
// Raw text via Vite (these tests run in the renderer's config, without Node's fs).
import mapRaw from './emoji-map.json?raw';
import datasourceRaw from 'emoji-datasource/emoji.json?raw';

describe('before the map is loaded', () => {
  it('returns undefined instead of throwing', () => {
    expect(isEmojiMapLoaded()).toBe(false);
    expect(emojiFromShortcode('smile')).toBeUndefined();
  });
});

describe('emojiFromShortcode', () => {
  beforeAll(() => loadEmojiMap());

  it('loads once and reports readiness', async () => {
    expect(isEmojiMapLoaded()).toBe(true);
    await expect(loadEmojiMap()).resolves.toBeUndefined();
  });

  it('resolves primary names and aliases', () => {
    expect(emojiFromShortcode('smile')).toBe('😄');
    expect(emojiFromShortcode('+1')).toBe('👍');
    expect(emojiFromShortcode('thumbsup')).toBe('👍');
    expect(emojiFromShortcode('-1')).toBe('👎');
    expect(emojiFromShortcode('100')).toBe('💯');
    expect(emojiFromShortcode('white_check_mark')).toBe('✅');
    expect(emojiFromShortcode('flag-us')).toBe('🇺🇸');
    expect(emojiFromShortcode('heart')).toBe('❤️');
  });

  it('accepts surrounding colons', () => {
    expect(emojiFromShortcode(':tada:')).toBe('🎉');
  });

  it('applies single skin tones', () => {
    expect(emojiFromShortcode('+1::skin-tone-2')).toBe('👍🏻');
    expect(emojiFromShortcode(':+1::skin-tone-3:')).toBe('👍🏼');
    expect(emojiFromShortcode('thumbsup::skin-tone-6')).toBe('👍🏿');
    expect(emojiFromShortcode('wave::skin-tone-4')).toBe('👋🏽');
  });

  it('drops the VS16 selector when toning emoji that carry one', () => {
    // ✌️ is U+270C U+FE0F; its toned form has no FE0F.
    expect(emojiFromShortcode('v::skin-tone-3')).toBe('✌\u{1F3FC}');
  });

  it('tones ZWJ sequences on the first person', () => {
    const toned = emojiFromShortcode('man-raising-hand::skin-tone-5');
    expect(toned).toBe('\u{1F64B}\u{1F3FE}‍♂️');
  });

  it('supports two-person tones', () => {
    const same = emojiFromShortcode('people_holding_hands::skin-tone-3');
    const mixed = emojiFromShortcode('people_holding_hands::skin-tone-2-6');
    expect(same).toBe('\u{1F9D1}\u{1F3FC}‍\u{1F91D}‍\u{1F9D1}\u{1F3FC}');
    expect(mixed).toBe('\u{1F9D1}\u{1F3FB}‍\u{1F91D}‍\u{1F9D1}\u{1F3FF}');
    expect(emojiFromShortcode('handshake::skin-tone-2-4')).toBe('\u{1FAF1}\u{1F3FB}‍\u{1FAF2}\u{1F3FD}');
    expect(emojiFromShortcode('handshake::skin-tone-3')).toBe('\u{1F91D}\u{1F3FC}');
  });

  it('shows the plain emoji when a tone does not apply', () => {
    expect(emojiFromShortcode('smile::skin-tone-3')).toBe('😄');
  });

  it('knows the tone swatches themselves', () => {
    expect(emojiFromShortcode('skin-tone-2')).toBe('\u{1F3FB}');
  });

  it('returns undefined for unknown or malformed names', () => {
    expect(emojiFromShortcode('definitely_not_an_emoji')).toBeUndefined();
    expect(emojiFromShortcode('party-parrot')).toBeUndefined();
    expect(emojiFromShortcode('')).toBeUndefined();
    expect(emojiFromShortcode('constructor')).toBeUndefined();
    expect(emojiFromShortcode('__proto__')).toBeUndefined();
    expect(emojiFromShortcode('smile smile')).toBeUndefined();
  });
});

describe('splitShortcode', () => {
  it('splits names and tones in every Slack spelling', () => {
    expect(splitShortcode('+1')).toEqual({ name: '+1', skinTone: null });
    expect(splitShortcode(':+1:')).toEqual({ name: '+1', skinTone: null });
    expect(splitShortcode('+1::skin-tone-3')).toEqual({ name: '+1', skinTone: '3' });
    expect(splitShortcode(':+1::skin-tone-3:')).toEqual({ name: '+1', skinTone: '3' });
    expect(splitShortcode('handshake::skin-tone-2-5')).toEqual({ name: 'handshake', skinTone: '2-5' });
    expect(splitShortcode('skin-tone-2')).toEqual({ name: 'skin-tone-2', skinTone: null });
    expect(splitShortcode('a b')).toBeNull();
  });
});

describe('table builder', () => {
  it('uses explicit exceptions before the derivation rule', () => {
    const data: EmojiMapData = {
      v: 1,
      emoji: { foo: 'F', bar: 'B' },
      tone: ['foo'],
      multi: {},
      extra: { 'foo::skin-tone-4': 'X' },
    };
    const table = buildEmojiTable(data);
    expect(table.lookup('foo', '4')).toBe('X');
    expect(table.lookup('foo', '2')).toBe(applySkinTone('F', 2));
    expect(table.lookup('bar', '2')).toBe('B');
    expect(table.lookup('nope')).toBeUndefined();
  });
});

describe('generated emoji-map.json', () => {
  const raw = mapRaw;
  const data = JSON.parse(raw) as EmojiMapData;

  it('stays compact', () => {
    expect(new TextEncoder().encode(raw).length).toBeLessThan(120 * 1024);
  });

  it('covers the full emoji-datasource name set including aliases', () => {
    expect(data.v).toBe(1);
    expect(Object.keys(data.emoji).length).toBeGreaterThan(1800);
    expect(data.tone.length).toBeGreaterThan(250);
    expect(Object.keys(data.multi).length).toBeGreaterThan(5);
    for (const variants of Object.values(data.multi)) expect(variants).toHaveLength(25);
  });

  it('matches every skin variation in emoji-datasource', () => {
    const source = JSON.parse(datasourceRaw) as { short_name: string; skin_variations?: Record<string, { unified: string }> }[];
    const table = buildEmojiTable(data);
    const toneOf: Record<string, string> = { '1F3FB': '2', '1F3FC': '3', '1F3FD': '4', '1F3FE': '5', '1F3FF': '6' };
    let checked = 0;
    for (const entry of source) {
      for (const [key, variation] of Object.entries(entry.skin_variations ?? {})) {
        const tone = key.split('-').map((k) => toneOf[k]).join('-');
        const expected = String.fromCodePoint(...variation.unified.split('-').map((h) => parseInt(h, 16)));
        expect(table.lookup(entry.short_name, tone), `${entry.short_name} ${tone}`).toBe(expected);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1500);
  });
});
