/**
 * Pure emoji lookup built from the compact `emoji-map.json` (see scripts/gen-emoji.ts).
 *
 * File format (v1):
 * ```
 * {
 *   "v": 1,
 *   "source": "emoji-datasource@x.y.z",
 *   "emoji": { "<short name or alias>": "<native>" },
 *   "tone":  ["<primary short name>", …],   // single skin tones derivable with applySkinTone()
 *   "multi": { "<primary short name>": ["<native>" × 25] },  // two-person tones, see multiToneIndex()
 *   "extra": { "<primary short name>::skin-tone-N": "<native>" }  // single tones that don't follow the rule
 * }
 * ```
 * Skin-toned variants are not stored verbatim because 95% of them follow one rule (insert the
 * Fitzpatrick modifier after the first code point), which keeps the shipped JSON small.
 */

export interface EmojiMapData {
  v: number;
  source?: string;
  emoji: Record<string, string>;
  tone: string[];
  multi: Record<string, string[]>;
  extra: Record<string, string>;
}

/** Slack skin tones are 2..6 (`skin-tone-2` = light … `skin-tone-6` = dark). */
export type SkinTone = 2 | 3 | 4 | 5 | 6;

export interface ParsedShortcode {
  name: string;
  /** e.g. "3" or "2-4" (two-person emoji), null when no skin tone was given. */
  skinTone: string | null;
}

const FITZPATRICK = ['\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];
const VS16 = '️';

/** Accepts "+1", ":+1:", "+1::skin-tone-3", ":+1::skin-tone-3:" and "handshake::skin-tone-2-4". */
const SHORTCODE_RE = /^:?([^:\s]+?)(?:::skin-tone-([2-6](?:-[2-6])?))?:?$/;

export function splitShortcode(raw: string): ParsedShortcode | null {
  const m = SHORTCODE_RE.exec(raw.trim());
  if (!m) return null;
  return { name: m[1], skinTone: m[2] ?? null };
}

/**
 * Inserts the Fitzpatrick modifier after the first code point and drops a VS16 that followed it
 * (a modifier already forces emoji presentation). This matches every single-tone variant in
 * emoji-datasource; the generator verifies that and stores exceptions explicitly.
 */
export function applySkinTone(native: string, tone: SkinTone): string {
  const cps = Array.from(native);
  const rest = cps[1] === VS16 ? cps.slice(2) : cps.slice(1);
  return cps[0] + FITZPATRICK[tone - 2] + rest.join('');
}

/** Index into a `multi` array for the (first person, second person) tone pair. */
export function multiToneIndex(a: SkinTone, b: SkinTone): number {
  return (a - 2) * 5 + (b - 2);
}

function parseTones(skinTone: string): [SkinTone, SkinTone | null] | null {
  const m = /^([2-6])(?:-([2-6]))?$/.exec(skinTone);
  if (!m) return null;
  return [Number(m[1]) as SkinTone, m[2] ? (Number(m[2]) as SkinTone) : null];
}

export interface EmojiTable {
  /** Native emoji for a short name (with optional skin tone), or undefined when unknown. */
  lookup(name: string, skinTone?: string | null): string | undefined;
  readonly size: number;
}

export function buildEmojiTable(data: EmojiMapData): EmojiTable {
  // Maps (not plain objects) so names like "constructor" can never hit Object.prototype.
  const byName = new Map(Object.entries(data.emoji));
  const toneable = new Set(data.tone.map((n) => data.emoji[n]).filter(Boolean));
  const multi = new Map<string, string[]>();
  for (const [name, variants] of Object.entries(data.multi)) {
    const native = data.emoji[name];
    if (native) multi.set(native, variants);
  }
  const extra = new Map<string, string>();
  for (const [key, value] of Object.entries(data.extra)) {
    const parsed = splitShortcode(key);
    const native = parsed && data.emoji[parsed.name];
    if (native && parsed.skinTone) extra.set(`${native}|${parsed.skinTone}`, value);
  }

  function withTone(base: string, skinTone: string): string {
    const tones = parseTones(skinTone);
    if (!tones) return base;
    const [a, b] = tones;
    const explicit = extra.get(`${base}|${skinTone}`);
    if (explicit) return explicit;
    const singleTone = b === null || a === b;
    if (singleTone && toneable.has(base)) return applySkinTone(base, a);
    const pairs = multi.get(base);
    const pair = pairs?.[multiToneIndex(a, b ?? a)];
    if (pair) return pair;
    // Slack shows the plain emoji when a tone doesn't apply; so do we.
    return toneable.has(base) ? applySkinTone(base, a) : base;
  }

  return {
    size: byName.size,
    lookup(name, skinTone) {
      const base = byName.get(name);
      if (base === undefined) return undefined;
      return skinTone ? withTone(base, skinTone) : base;
    },
  };
}
