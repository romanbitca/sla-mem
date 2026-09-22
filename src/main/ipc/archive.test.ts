import { describe, expect, it } from 'vitest';
import { msg, seededDb, tsAt } from '../db/test-helpers';
import { upsertMessages } from '../db/write';
import { archivePaths } from '../paths';
import { archiveHandlers } from './archive';

function handlers() {
  const db = seededDb();
  upsertMessages(db, 'D1', [msg(tsAt(1), 'hello')], 'api');
  return archiveHandlers({ db, paths: archivePaths('/tmp/unused'), isConnected: () => true });
}

describe('People calls', () => {
  it('lists people and opens one', async () => {
    const h = handlers();
    expect((await h.getPeople()).map((p) => p.userId)).toEqual(['U1']);
    expect(await h.getPerson({ id: 'U1' })).toMatchObject({
      userId: 'U1',
      dm: { conversationId: 'D1', messageCount: 1 },
    });
  });

  it('refuses a malformed id and says when someone isn’t in the archive', () => {
    const h = handlers();
    expect(() => h.getPerson({ id: '../U1' })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => h.getPerson({ id: 'UNOBODY' })).toThrow(
      expect.objectContaining({ code: 'not_found', message: 'That person isn’t in the archive.' }),
    );
  });
});
