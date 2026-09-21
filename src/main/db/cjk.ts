/**
 * Chinese and Japanese don't put spaces between words, and SQLite's unicode61 tokenizer only splits
 * on spaces and punctuation: a whole CJK sentence would be one token, so a word inside it could
 * never be found. The search text therefore separates CJK ideographs and kana into single-character
 * tokens, CJK search terms become phrases of those characters, and snippets join them back up for
 * display (PLAN §11 Stage 8). Korean uses spaces between words and is left alone.
 */

const CJK_CHAR = '[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\u30fc]';
const BETWEEN_CJK = new RegExp(`(${CJK_CHAR})(?=${CJK_CHAR})`, 'gu');
const HAS_CJK = new RegExp(CJK_CHAR, 'u');
// A space we inserted: between two CJK characters, possibly with highlight markers around it.
const INSERTED_SPACE = new RegExp(`(${CJK_CHAR}\\u0003?) (?=\\u0002?${CJK_CHAR})`, 'gu');

export function hasCjk(s: string): boolean {
  return HAS_CJK.test(s);
}

/** "今天的会议" → "今 天 的 会 议" (search text only). */
export function segmentCjk(s: string): string {
  return hasCjk(s) ? s.replace(BETWEEN_CJK, '$1 ') : s;
}

/** Undoes segmentCjk in snippets, keeping highlight markers where they were. */
export function desegmentCjk(s: string): string {
  return hasCjk(s) ? s.replace(INSERTED_SPACE, '$1') : s;
}
