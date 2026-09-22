import { describe, expect, it } from 'vitest';
import type { PersonSummaryDTO } from '../../shared/types';
import { makeUser } from '../test/helpers';
import { briefQuestion, firstName, localTimeIn, peopleSections, shortUrl, timeDifferenceLabel } from './people';

function summary(userId: string, extra: Partial<PersonSummaryDTO> = {}): PersonSummaryDTO {
  return {
    userId,
    title: null,
    tz: null,
    messageCount: 1,
    lastMessageTs: '1700000000.000000',
    dmConversationId: null,
    dmMessageCount: 0,
    lastTalkedTs: null,
    ...extra,
  };
}

const users = new Map(
  [
    makeUser('U1', 'Ana Pop', { name: 'ana.pop' }),
    makeUser('U2', 'Bo', { name: 'bo' }),
    makeUser('U3', 'Cy', { name: 'cy' }),
    makeUser('U4', 'Dee', { name: 'dee', deleted: true }),
    makeUser('U5', 'Eve', { name: 'eve' }),
  ].map((u) => [u.id, u]),
);

describe('peopleSections', () => {
  const people = [
    summary('U1', { lastTalkedTs: '1700000100.000000', dmConversationId: 'D1', dmMessageCount: 3 }),
    summary('U2', { lastTalkedTs: '1700000900.000000', title: 'Designer' }),
    summary('U3', { lastMessageTs: '1700000500.000000' }),
    summary('U4', { lastTalkedTs: '1700000990.000000' }),
    summary('U5', { lastMessageTs: '1700000800.000000' }),
  ];

  it('groups people you message, people in your channels and people who left, newest first', () => {
    expect(peopleSections(people, users).map((s) => [s.id, s.people.map((p) => p.userId)])).toEqual([
      ['talk', ['U2', 'U1']],
      ['channels', ['U5', 'U3']],
      ['left', ['U4']],
    ]);
  });

  it('filters by name, Slack handle or title, and drops empty sections', () => {
    expect(peopleSections(people, users, 'design').map((s) => s.people.map((p) => p.userId))).toEqual([['U2']]);
    expect(peopleSections(people, users, ' ANA.').map((s) => s.people.map((p) => p.userId))).toEqual([['U1']]);
    expect(peopleSections(people, users, 'nobody')).toEqual([]);
  });
});

describe('time zones', () => {
  it('says how far ahead or behind their clock is', () => {
    expect(timeDifferenceLabel(0)).toBeNull();
    expect(timeDifferenceLabel(60)).toBe('1 hour ahead');
    expect(timeDifferenceLabel(-120)).toBe('2 hours behind');
    expect(timeDifferenceLabel(210)).toBe('3½ hours ahead');
    expect(timeDifferenceLabel(30)).toBe('30 minutes ahead');
    expect(timeDifferenceLabel(-45)).toBe('45 minutes behind');
    expect(timeDifferenceLabel(345)).toBe('5 h 45 min ahead');
  });

  it('reads their clock from the zone, whatever this computer’s zone is', () => {
    const at = new Date(Date.UTC(2026, 8, 22, 15, 4));
    const utc = localTimeIn('UTC', at)!;
    expect(utc.time).toBe('3:04 PM');
    expect(utc.diffMinutes).toBe(at.getTimezoneOffset());
    const kolkata = localTimeIn('Asia/Kolkata', at)!;
    expect(kolkata.time).toBe('8:34 PM');
    expect(kolkata.diffMinutes - utc.diffMinutes).toBe(330);
    expect(localTimeIn('Not/AZone', at)).toBeNull();
  });
});

describe('small helpers', () => {
  it('names someone by their first name, when they have one', () => {
    expect(firstName('Gerhardt Camilleri')).toBe('Gerhardt');
    expect(firstName('Geri')).toBe('Geri');
    expect(firstName('J Smith')).toBe('J Smith');
  });

  it('shortens a link to its host and path', () => {
    expect(shortUrl('https://www.example.com/a/b/?x=1#y')).toBe('example.com/a/b');
    expect(shortUrl('https://docs.google.com/')).toBe('docs.google.com');
    expect(shortUrl('not a url')).toBe('not a url');
  });

  it('asks Ask AI for a brief with the name and the Slack handle', () => {
    expect(briefQuestion({ label: 'Geri', realName: 'Gerhardt Camilleri', name: 'geri.camilleri' })).toBe(
      'Brief me on Gerhardt Camilleri (@geri.camilleri) before we talk: what we’re working on together, what we decided lately, and what’s still open between us (questions either of us hasn’t answered, anything I promised).',
    );
    expect(briefQuestion({ label: 'bo', realName: null, name: 'bo' })).toMatch(/^Brief me on bo before we talk/);
  });
});
