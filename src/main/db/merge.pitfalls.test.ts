/**
 * The archive's prime directive (PLAN §5.1): never lose or degrade data already stored. One test
 * per merge rule of PLAN §5.5, plus the data-safety findings of PLAN §12 (items 1–4).
 */
import { describe, expect, it } from 'vitest';
import { getMessageRevisions, getThread } from './read';
import { msg, seededDb, tsAt } from './test-helpers';
import type { DB, MessageRow } from './types';
import { upsertMessages } from './write';

const row = (db: DB, ts: string): MessageRow =>
  db.prepare("SELECT * FROM messages WHERE conversation_id = 'C1' AND ts = ?").get(ts) as MessageRow;
const count = (db: DB): number => (db.prepare('SELECT count(*) AS n FROM messages').get() as { n: number }).n;

describe('merge policy (PLAN §5.5)', () => {
  it('1. never deletes message rows, whatever arrives', () => {
    const db = seededDb();
    upsertMessages(db, 'C1', [msg(tsAt(1), 'a'), msg(tsAt(2), 'b')], 'api');
    upsertMessages(db, 'C1', [{ ts: tsAt(1), subtype: 'tombstone', text: '' }], 'api');
    upsertMessages(db, 'C1', [], 'api');
    expect(count(db)).toBe(2);
  });

  it('2. incoming wins for text, edits, reactions and raw', () => {
    const db = seededDb();
    upsertMessages(db, 'C1', [msg(tsAt(1), 'v1', { reactions: [{ name: 'eyes', count: 1, users: ['U2'] }] })], 'api');
    upsertMessages(db, 'C1', [msg(tsAt(1), 'v2', { edited: { ts: tsAt(2) }, reactions: [] })], 'api');
    expect(row(db, tsAt(1))).toMatchObject({ text: 'v2', edited_ts: tsAt(2), reactions: '[]' });
    expect(JSON.parse(row(db, tsAt(1)).raw).text).toBe('v2');
  });

  it('3. a tombstone keeps text, raw and files, and sets is_deleted', () => {
    const db = seededDb();
    const files = [{ id: 'F1', name: 'plan.pdf', url_private: 'https://f/1' }];
    upsertMessages(db, 'C1', [msg(tsAt(1), 'the plan', { files })], 'api');
    const before = row(db, tsAt(1));
    upsertMessages(
      db,
      'C1',
      [
        {
          ts: tsAt(1),
          subtype: 'tombstone',
          text: 'This message was deleted.',
          files: [{ id: 'F1', mode: 'tombstone' }],
        },
      ],
      'api',
    );
    expect(row(db, tsAt(1))).toMatchObject({ text: 'the plan', raw: before.raw, is_deleted: 1, has_files: 1 });
    expect((db.prepare("SELECT name, download_status FROM files WHERE id = 'F1'").get() as { name: string }).name).toBe(
      'plan.pdf',
    );
  });

  it('4. an edit stores the previous text as a revision', () => {
    const db = seededDb();
    upsertMessages(db, 'C1', [msg(tsAt(1), 'first')], 'api');
    upsertMessages(db, 'C1', [msg(tsAt(1), 'second', { edited: { ts: tsAt(2) } })], 'api');
    upsertMessages(db, 'C1', [msg(tsAt(1), 'third', { edited: { ts: tsAt(3) } })], 'api');
    expect(getMessageRevisions(db, 'C1', tsAt(1)).map((r) => r.text)).toEqual(['first', 'second']);
  });

  it('5. an empty copy never blanks stored text unless it carries a newer edit', () => {
    const db = seededDb();
    upsertMessages(db, 'C1', [msg(tsAt(1), 'keep me')], 'api');
    upsertMessages(db, 'C1', [msg(tsAt(1), '')], 'api');
    expect(row(db, tsAt(1)).text).toBe('keep me');
  });

  it('6. reply_count and latest_reply never regress', () => {
    const db = seededDb();
    const parent = tsAt(1);
    upsertMessages(db, 'C1', [msg(parent, 'p', { thread_ts: parent, reply_count: 5, latest_reply: tsAt(9) })], 'api');
    upsertMessages(
      db,
      'C1',
      [msg(parent, 'p', { thread_ts: parent, reply_count: 2, latest_reply: tsAt(4) })],
      'import',
    );
    expect(row(db, parent)).toMatchObject({ reply_count: 5, latest_reply: tsAt(9) });
  });

  it('7. first_seen_at is preserved forever', () => {
    const db = seededDb();
    upsertMessages(db, 'C1', [msg(tsAt(1), 'a')], 'api');
    const first = row(db, tsAt(1)).first_seen_at;
    upsertMessages(db, 'C1', [msg(tsAt(1), 'b', { edited: { ts: tsAt(2) } })], 'api');
    expect(row(db, tsAt(1)).first_seen_at).toBe(first);
  });

  it('8. sparse copies keep authorship; files, images and deletion are sticky', () => {
    const db = seededDb();
    const files = [{ id: 'F1', name: 'a.png', mimetype: 'image/png', url_private: 'https://f/a' }];
    upsertMessages(db, 'C1', [msg(tsAt(1), 'pic', { user: 'U1', bot_id: 'B1', username: 'bot', files })], 'api');
    upsertMessages(db, 'C1', [{ ts: tsAt(1), text: 'pic', edited: { ts: tsAt(2) } }], 'api');
    expect(row(db, tsAt(1))).toMatchObject({
      user_id: 'U1',
      bot_id: 'B1',
      username: 'bot',
      has_files: 1,
      has_images: 1,
    });
    upsertMessages(db, 'C1', [{ ts: tsAt(1), subtype: 'tombstone', text: '' }], 'api');
    upsertMessages(db, 'C1', [msg(tsAt(1), 'pic', { edited: { ts: tsAt(3) } })], 'api');
    expect(row(db, tsAt(1)).is_deleted).toBe(1);
  });
});

describe('data-safety findings (PLAN §12)', () => {
  it('1. an edit that empties the text keeps the archived words as a revision', () => {
    const db = seededDb();
    upsertMessages(db, 'C1', [msg(tsAt(1), 'the important decision')], 'api');
    upsertMessages(db, 'C1', [msg(tsAt(1), '', { edited: { ts: tsAt(2) } })], 'api');
    expect(row(db, tsAt(1)).text).toBe('');
    expect(getMessageRevisions(db, 'C1', tsAt(1)).map((r) => r.text)).toEqual(['the important decision']);
  });

  it('2. an older export imported after an API sync does not roll back reactions, edits or replies', () => {
    const db = seededDb();
    const parent = tsAt(1);
    upsertMessages(
      db,
      'C1',
      [
        msg(parent, 'final', {
          thread_ts: parent,
          edited: { ts: tsAt(5) },
          reply_count: 3,
          latest_reply: tsAt(8),
          reactions: [{ name: 'tada', count: 3, users: ['U1', 'U2', 'U3'] }],
        }),
        msg(tsAt(2), 'plain', { reactions: [{ name: 'eyes', count: 2, users: ['U1', 'U2'] }] }),
      ],
      'api',
    );
    upsertMessages(
      db,
      'C1',
      [
        msg(parent, 'draft', { thread_ts: parent, reply_count: 1, latest_reply: tsAt(3), reactions: [] }),
        msg(tsAt(2), 'plain', { reactions: [{ name: 'eyes', count: 1, users: ['U1'] }] }),
      ],
      'import',
    );
    expect(row(db, parent)).toMatchObject({ text: 'final', edited_ts: tsAt(5), reply_count: 3, latest_reply: tsAt(8) });
    expect(JSON.parse(row(db, parent).reactions)).toHaveLength(1);
    expect(JSON.parse(row(db, tsAt(2)).reactions)).toEqual([{ name: 'eyes', count: 2, users: ['U1', 'U2'] }]);
  });

  it('3. a locked copy never overwrites content, and never freezes the row against later updates', () => {
    const db = seededDb();
    upsertMessages(db, 'C1', [msg(tsAt(1), 'visible text')], 'api');
    upsertMessages(db, 'C1', [msg(tsAt(1), '', { is_locked: true })], 'api');
    expect(row(db, tsAt(1)).text).toBe('visible text');
    upsertMessages(db, 'C1', [msg(tsAt(1), 'edited later', { edited: { ts: tsAt(2) } })], 'api');
    expect(row(db, tsAt(1)).text).toBe('edited later');
  });

  it('4. a malformed timestamp skips that row only and is counted', () => {
    const db = seededDb();
    const res = upsertMessages(
      db,
      'C1',
      [msg(tsAt(1), 'ok'), msg('17000oops', 'bad'), { text: 'no ts' } as never, null as never, msg(tsAt(2), 'ok too')],
      'import',
    );
    expect(res).toMatchObject({ inserted: 2, skipped: 3 });
  });

  it('records the writer only when something changed (an identical import is a no-op)', () => {
    const db = seededDb();
    upsertMessages(db, 'C1', [msg(tsAt(1), 'same')], 'api');
    expect(upsertMessages(db, 'C1', [msg(tsAt(1), 'same')], 'import')).toMatchObject({ updated: 0 });
    expect(row(db, tsAt(1)).source).toBe('api');
  });

  it('keeps a deleted thread parent readable with its replies', () => {
    const db = seededDb();
    const parent = tsAt(1);
    upsertMessages(
      db,
      'C1',
      [msg(parent, 'question?', { thread_ts: parent, reply_count: 1, latest_reply: tsAt(2) })],
      'api',
    );
    upsertMessages(db, 'C1', [msg(tsAt(2), 'answer', { thread_ts: parent })], 'api');
    upsertMessages(
      db,
      'C1',
      [{ ts: parent, thread_ts: parent, subtype: 'tombstone', text: 'This message was deleted.', reply_count: 1 }],
      'api',
    );
    const thread = getThread(db, 'C1', parent);
    expect(thread.parent).toMatchObject({ text: 'question?', isDeleted: true });
    expect(thread.replies.map((r) => r.text)).toEqual(['answer']);
  });
});

describe('bots', () => {
  it('remembers integrations by bot_id with their name and icon', () => {
    const db = seededDb();
    upsertMessages(
      db,
      'C1',
      [
        msg(tsAt(1), 'hi', {
          user: undefined,
          bot_id: 'BGH',
          bot_profile: { name: 'GitHub', icons: { image_48: 'https://i/gh.png' } },
        }),
      ],
      'api',
    );
    upsertMessages(db, 'C1', [msg(tsAt(2), 'again', { user: undefined, bot_id: 'BGH' })], 'api');
    expect(db.prepare("SELECT id, name, icon_url FROM bots WHERE id = 'BGH'").get()).toEqual({
      id: 'BGH',
      name: 'GitHub',
      icon_url: 'https://i/gh.png',
    });
  });
});
