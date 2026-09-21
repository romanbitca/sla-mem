import { describe, expect, it } from 'vitest';
import { getConversation, openDb, upsertConversations } from '../db';
import { pickLocalCopy, sanitizeFileName } from './attachments';
import { analyzeLayout, fileIdFromPath, localFileName } from './layout';
import { exportingUserFromDms, parseListing, planConversations, userFromMessage } from './listing';
import { findExportRoot, isJunkPath, safeEntryPath } from './source';

describe('fileIdFromPath', () => {
  it.each([
    ['__uploads/F0DIAGRAM1/diagram.png', 'F0DIAGRAM1'],
    ['__uploads/F0DIAGRAM1/data.json', 'F0DIAGRAM1'], // an uploaded .json is still an upload
    ['general/attachments/F0BUDGET01-budget 2024.pdf', 'F0BUDGET01'],
    ['D0ALICE001/attachments/F0NOTES0001-notes.txt', 'F0NOTES0001'],
    ['files/F0ABCDEFGH/report.pdf', 'F0ABCDEFGH'],
    ['random/F0ABCDEFGH_report.pdf', 'F0ABCDEFGH'],
    ['random/F0ABCDEFGH.png', 'F0ABCDEFGH'],
  ])('%s → %s', (p, id) => {
    expect(fileIdFromPath(p)).toBe(id);
  });

  it.each([
    'general/notes.txt',
    '__avatars/U0ALICE001/avatar.png',
    'random/FILE.json',
    'files/F0ABCDEFGH/meta.json', // JSON outside the confirmed layouts is export data, not an upload
    'random/F0ABC-too-short.png',
    'random/Fabcdefghij.png', // lower-case: not a Slack id
  ])('%s → null', (p) => {
    expect(fileIdFromPath(p)).toBeNull();
  });

  it('recovers the original name of standard-layout copies', () => {
    expect(localFileName('general/attachments/F0BUDGET01-budget 2024.pdf', 'F0BUDGET01')).toBe('budget 2024.pdf');
    expect(localFileName('__uploads/F0DIAGRAM1/diagram.png', 'F0DIAGRAM1')).toBe('diagram.png');
  });
});

describe('analyzeLayout', () => {
  it('classifies listings, conversation folders and attachments', () => {
    const layout = analyzeLayout([
      'users.json',
      'channels.json',
      'dms.json',
      'canvases.json',
      'integration_logs.json',
      'general/2024-03-02.json',
      'general/2024-03-01.json',
      'general/attachments/F0BUDGET01-budget.pdf',
      'D0ALICE001/2024-03-02.json',
      '__uploads/F0DIAGRAM1/diagram.png',
      'general/readme.json',
    ]);
    expect([...layout.listings].sort()).toEqual(['channels', 'dms', 'users']);
    expect([...layout.folders.keys()].sort()).toEqual(['D0ALICE001', 'general']);
    expect(layout.folders.get('general')).toEqual(['general/2024-03-01.json', 'general/2024-03-02.json']);
    expect(layout.attachments.get('F0BUDGET01')).toEqual(['general/attachments/F0BUDGET01-budget.pdf']);
    expect(layout.attachments.get('F0DIAGRAM1')).toEqual(['__uploads/F0DIAGRAM1/diagram.png']);
    expect(layout.attachments.size).toBe(2);
  });
});

describe('export root detection', () => {
  it('keeps a plain export at the root', () => {
    expect(findExportRoot(['users.json', 'general/2024-03-01.json'])).toBe('');
  });

  it('strips one or more wrapper folders', () => {
    expect(findExportRoot(['wrap/users.json', 'wrap/general/2024-03-01.json'])).toBe('wrap/');
    expect(findExportRoot(['a/b/channels.json', 'a/b/c/2024-03-01.json'])).toBe('a/b/');
  });

  it('does not treat a lone conversation folder as a wrapper', () => {
    expect(findExportRoot(['general/2024-03-01.json', 'general/2024-03-02.json'])).toBe('');
  });

  it('stops when the wrapper holds more than one thing', () => {
    expect(findExportRoot(['wrap/users.json', 'README.txt'])).toBe('');
  });
});

describe('safeEntryPath / isJunkPath', () => {
  it.each([
    ['users.json', 'users.json'],
    ['./general//2024-03-01.json', 'general/2024-03-01.json'],
    ['general\\2024-03-01.json', 'general/2024-03-01.json'],
  ])('%s is normalized to %s', (input, out) => {
    expect(safeEntryPath(input)).toBe(out);
  });

  it.each(['../evil.json', 'a/../../evil', '/etc/passwd', 'C:\\Windows\\x', 'C:/x', '', '.'])(
    '%s is rejected',
    (input) => {
      expect(safeEntryPath(input)).toBeNull();
    },
  );

  it('flags macOS and Windows metadata', () => {
    expect(isJunkPath('__MACOSX/export/._users.json')).toBe(true);
    expect(isJunkPath('export/.DS_Store')).toBe(true);
    expect(isJunkPath('general/._2024-03-01.json')).toBe(true);
    expect(isJunkPath('general/2024-03-01.json')).toBe(false);
  });
});

describe('sanitizeFileName', () => {
  it.each([
    ['diagram.png', 'diagram.png'],
    ['budget 2024.pdf', 'budget 2024.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\boot.ini', 'boot.ini'],
    ['..', 'file'],
    ['', 'file'],
    ['.env', 'env'],
    ['a\u0000b\nc.txt', 'a_b_c.txt'],
    ['what?.txt', 'what_.txt'],
  ])('%j → %j', (input, out) => {
    expect(sanitizeFileName(input)).toBe(out);
  });

  it('caps the length at 150 characters and keeps the extension', () => {
    const name = sanitizeFileName(`${'x'.repeat(300)}.jpeg`);
    expect(name).toHaveLength(150);
    expect(name.endsWith('.jpeg')).toBe(true);
  });

  it('prefers the local copy whose name matches', () => {
    const candidates = ['__uploads/F0A1B2C3D4/other.png', 'general/attachments/F0A1B2C3D4-photo.png'];
    expect(pickLocalCopy(candidates, 'photo.png')).toBe('general/attachments/F0A1B2C3D4-photo.png');
    expect(pickLocalCopy(candidates, 'missing.png')).toBe('__uploads/F0A1B2C3D4/other.png');
  });
});

describe('listings', () => {
  it('finds the exporting user only when unambiguous', () => {
    const dm = (...members: string[]) => ({ id: 'D1', members });
    expect(exportingUserFromDms([dm('A', 'ME'), dm('B', 'ME')])).toBe('ME');
    expect(exportingUserFromDms([dm('A', 'ME'), dm('ME', 'ME')])).toBe('ME'); // self-DM
    expect(exportingUserFromDms([dm('A', 'ME')])).toBeNull(); // one DM: either could be "me"
    expect(exportingUserFromDms([dm('A', 'ME'), dm('B', 'C')])).toBeNull();
    expect(exportingUserFromDms([])).toBeNull();
    expect(exportingUserFromDms(undefined)).toBeNull();
  });

  it('rejects malformed listing files with the file name', () => {
    expect(() => parseListing('channels', '{nope')).toThrow(/channels\.json is not valid JSON/);
    expect(() => parseListing('users', '{"id":"U1"}')).toThrow(/users\.json must contain a JSON array/);
    expect(parseListing('users', '[{"id":"U1"},{"name":"no id"},null,"x"]')).toEqual([{ id: 'U1' }]);
  });

  it('types conversations by listing file but keeps explicit privacy flags', () => {
    const plan = planConversations(
      {
        channels: [
          { id: 'C1', name: 'general' },
          { id: 'C2', name: 'modern-private', is_private: true, is_channel: true },
        ],
        groups: [{ id: 'C3', name: 'legacy-private' }],
        mpims: [{ id: 'G1', name: 'mpdm-a--b--c-1', members: ['A', 'B', 'ME'] }],
        dms: [
          { id: 'D1', members: ['A', 'ME'] },
          { id: 'D2', members: ['ME', 'ME'] },
        ],
      },
      'ME',
    );
    const db = openDb(':memory:');
    upsertConversations(db, plan.conversations);
    const typeOf = (id: string) => getConversation(db, id)?.type;
    expect(typeOf('C1')).toBe('channel');
    expect(typeOf('C2')).toBe('private_channel');
    expect(typeOf('C3')).toBe('private_channel');
    expect(typeOf('G1')).toBe('mpim');
    expect(typeOf('D1')).toBe('im');
    expect(getConversation(db, 'D1')?.dmUserId).toBe('A');
    expect(getConversation(db, 'D2')?.dmUserId).toBe('ME');
    expect(Object.fromEntries(plan.folderToConversation)).toMatchObject({
      general: 'C1',
      C1: 'C1',
      'mpdm-a--b--c-1': 'G1',
      D1: 'D1',
    });
    db.close();
  });

  it('builds minimal users from embedded message profiles', () => {
    expect(
      userFromMessage({
        ts: '1.0',
        user: 'U1',
        user_team: 'T1',
        user_profile: { name: 'ann', real_name: 'Ann Lee', display_name: '', image_72: 'https://x/a.png' },
      }),
    ).toMatchObject({
      id: 'U1',
      team_id: 'T1',
      name: 'ann',
      real_name: 'Ann Lee',
      profile: { image_72: 'https://x/a.png' },
    });
    expect(userFromMessage({ ts: '1.0', user: 'U1' })).toBeNull();
    expect(userFromMessage({ ts: '1.0', user_profile: { name: 'x' } })).toBeNull();
  });
});
