import { describe, expect, it } from 'vitest';
import { desegmentCjk, segmentCjk } from './cjk';
import { search } from './search';
import { msg, seededDb, tsAt } from './test-helpers';
import { upsertMessages } from './write';

// Written with escapes so the source stays ASCII: 今天的会议取消了，明天再说 / 週末の打ち合わせは中止になりました /
// 오늘 회의가 취소되었습니다 / Deploy 会议 notes.
const ZH = '今天的会议取消了，明天再说';
const JA = '週末の打ち合わせは中止になりました';
const KO = '오늘 회의가 취소되었습니다';
const MIXED = 'Deploy 会议 notes for v2';
const MEETING = '会议'; // 会议
const CANCEL = '取消'; // 取消
const MEETING_JA = '打ち合わせ'; // 打ち合わせ
const STOPPED = '中止'; // 中止
const MEETING_KO = '회의가'; // 회의가

describe('CJK search (PLAN §11 Stage 8)', () => {
  const db = seededDb();
  upsertMessages(db, 'C1', [msg(tsAt(1), ZH), msg(tsAt(2), JA), msg(tsAt(3), KO), msg(tsAt(4), MIXED)], 'api');
  const texts = (q: string) => search(db, { q, sort: 'oldest' }).hits.map((h) => h.message.text);

  it('finds a Chinese word inside a sentence', () => {
    expect(texts(MEETING)).toEqual([ZH, MIXED]);
    expect(texts(CANCEL)).toEqual([ZH]);
  });

  it('finds Japanese words written in kanji and kana', () => {
    expect(texts(MEETING_JA)).toEqual([JA]);
    expect(texts(STOPPED)).toEqual([JA]);
  });

  it('leaves Korean (space-separated) to the normal tokenizer', () => {
    expect(texts(MEETING_KO)).toEqual([KO]);
  });

  it('shows snippets without the inserted spaces, with highlights intact', () => {
    const [hit] = search(db, { q: CANCEL }).hits;
    expect(hit.snippet.replace(/[\u0002\u0003]/g, '')).toBe(ZH);
    // FTS5 highlights the matched phrase as one span.
    expect(hit.snippet).toContain(`\u0002${CANCEL}\u0003`);
  });

  it('segments and joins back losslessly', () => {
    const s = 'Mixed 日本語 and English';
    expect(segmentCjk(s)).toBe('Mixed 日 本 語 and English');
    expect(desegmentCjk(segmentCjk(s))).toBe(s);
  });
});
