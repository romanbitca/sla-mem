import { describe, expect, it } from 'vitest';
import { msg, seededDb, tsAt } from '../db/test-helpers';
import { upsertMessages } from '../db/write';
import { archivePaths } from '../paths';
import { DEFAULT_WORK_HOURS } from '../preferences';
import { archiveHandlers } from './archive';

function handlers() {
  const db = seededDb();
  upsertMessages(db, 'D1', [msg(tsAt(1), 'hello')], 'api');
  return archiveHandlers({
    db,
    paths: archivePaths('/tmp/unused'),
    isConnected: () => true,
    workHours: () => DEFAULT_WORK_HOURS,
  });
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

describe('My style call', () => {
  it('reads the style with the working hours from Settings', async () => {
    const hours = { days: [0, 1, 2, 3, 4], start: 480, end: 1020, timeZone: 'Africa/Cairo' };
    const h = archiveHandlers({
      db: seededDb(),
      paths: archivePaths('/tmp/unused'),
      isConnected: () => true,
      workHours: () => hours,
    });
    expect((await h.getStyle()).hours).toEqual({ ...hours, timeZoneIsDefault: false });
  });
});
