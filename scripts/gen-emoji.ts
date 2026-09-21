/**
 * Generates src/renderer/lib/emoji/emoji-map.json from emoji-datasource (iamcal's data set, which is
 * what Slack's own shortcodes come from). The output format is documented in
 * src/renderer/lib/emoji/table.ts.
 *
 *   npm run gen:emoji
 *
 * Re-run after upgrading emoji-datasource and commit the JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applySkinTone, multiToneIndex, type EmojiMapData, type SkinTone } from '../src/renderer/lib/emoji/table';

interface SkinVariation {
  unified: string;
}

interface DatasourceEmoji {
  unified: string;
  short_name: string;
  short_names: string[];
  sort_order?: number;
  skin_variations?: Record<string, SkinVariation>;
}

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(rootDir, 'node_modules', 'emoji-datasource');
const outFile = path.join(rootDir, 'src', 'renderer', 'lib', 'emoji', 'emoji-map.json');

/** Fitzpatrick modifier code point (hex, as used in emoji-datasource keys) → Slack tone number. */
const TONE_BY_MODIFIER: Record<string, SkinTone> = {
  '1F3FB': 2,
  '1F3FC': 3,
  '1F3FD': 4,
  '1F3FE': 5,
  '1F3FF': 6,
};

function unifiedToNative(unified: string): string {
  return String.fromCodePoint(...unified.split('-').map((hex) => parseInt(hex, 16)));
}

function readDatasource(): { emoji: DatasourceEmoji[]; version: string } {
  const emoji = JSON.parse(fs.readFileSync(path.join(sourceDir, 'emoji.json'), 'utf8')) as DatasourceEmoji[];
  const pkg = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8')) as { version: string };
  return { emoji, version: pkg.version };
}

function addNames(data: EmojiMapData, entry: DatasourceEmoji, native: string, warnings: string[]): void {
  for (const name of entry.short_names) {
    const existing = data.emoji[name];
    if (existing !== undefined && existing !== native) {
      warnings.push(`duplicate short name "${name}" (kept the first)`);
      continue;
    }
    data.emoji[name] = native;
  }
}

function addSkinTones(data: EmojiMapData, entry: DatasourceEmoji, native: string): void {
  const variations = entry.skin_variations;
  if (!variations) return;
  let derivable = false;
  const pairs: string[] = new Array<string>(25).fill('');
  let hasPairs = false;

  for (const [key, variation] of Object.entries(variations)) {
    const variantNative = unifiedToNative(variation.unified);
    const modifiers = key.split('-');
    if (modifiers.length === 1) {
      const tone = TONE_BY_MODIFIER[modifiers[0]];
      if (!tone) continue;
      if (applySkinTone(native, tone) === variantNative) derivable = true;
      else data.extra[`${entry.short_name}::skin-tone-${tone}`] = variantNative;
    } else if (modifiers.length === 2) {
      const a = TONE_BY_MODIFIER[modifiers[0]];
      const b = TONE_BY_MODIFIER[modifiers[1]];
      if (!a || !b) continue;
      pairs[multiToneIndex(a, b)] = variantNative;
      hasPairs = true;
    }
  }
  if (derivable) data.tone.push(entry.short_name);
  if (hasPairs) data.multi[entry.short_name] = pairs;
}

/**
 * One key per line keeps the committed file reviewable in diffs while staying compact
 * (no indentation, no per-entry metadata).
 */
function serialize(data: EmojiMapData): string {
  const entries = (obj: Record<string, unknown>) =>
    Object.entries(obj)
      .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
      .join(',\n');
  return [
    '{',
    `"v":${data.v},`,
    `"source":${JSON.stringify(data.source)},`,
    `"emoji":{\n${entries(data.emoji)}\n},`,
    `"tone":${JSON.stringify(data.tone)},`,
    `"multi":{\n${entries(data.multi)}\n},`,
    `"extra":{${entries(data.extra)}}`,
    '}',
    '',
  ].join('\n');
}

function main(): void {
  const { emoji, version } = readDatasource();
  const data: EmojiMapData = { v: 1, source: `emoji-datasource@${version}`, emoji: {}, tone: [], multi: {}, extra: {} };
  const warnings: string[] = [];

  const sorted = [...emoji].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  for (const entry of sorted) {
    const native = unifiedToNative(entry.unified);
    addNames(data, entry, native, warnings);
    addSkinTones(data, entry, native);
  }

  const json = serialize(data);
  JSON.parse(json); // guard against a serializer bug producing invalid JSON
  fs.writeFileSync(outFile, json);

  for (const w of warnings) console.warn(`warning: ${w}`);
  console.log(
    `wrote ${path.relative(rootDir, outFile)}: ${Object.keys(data.emoji).length} names, ` +
      `${data.tone.length} toneable, ${Object.keys(data.multi).length} multi-tone, ` +
      `${Object.keys(data.extra).length} exceptions, ${(Buffer.byteLength(json) / 1024).toFixed(1)} KB`,
  );
}

main();
