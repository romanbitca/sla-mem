// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { api } from '../../lib/api';
import { buildDirectory } from '../../lib/directory';
import PeoplePage from '../../pages/PeoplePage';
import { makeConversation, makePersonSummary, makeUser, renderWithProviders } from '../../test/helpers';

const secondsAgo = (s: number) => `${Math.floor(Date.now() / 1000) - s}.000000`;
const DAY = 86_400;

const directory = buildDirectory(
  [
    makeUser('U1', 'Me'),
    makeUser('U2', 'Bob Brown', { name: 'bob' }),
    makeUser('U3', 'Carol Diaz', { name: 'carol' }),
    makeUser('U4', 'Dan', { name: 'dan', deleted: true }),
  ],
  [makeConversation('D2', 'Bob Brown', { type: 'im', dmUserId: 'U2' })],
  {},
  'U1',
  '9h',
);

const PEOPLE = [
  makePersonSummary('U2', {
    title: 'Designer',
    messageCount: 40,
    lastMessageTs: secondsAgo(DAY),
    dmConversationId: 'D2',
    dmMessageCount: 12,
    lastTalkedTs: secondsAgo(2 * DAY),
  }),
  makePersonSummary('U3', { messageCount: 7, lastMessageTs: secondsAgo(3 * 3600) }),
  makePersonSummary('U4', { messageCount: 3, lastMessageTs: secondsAgo(200 * DAY) }),
];

function renderPeople(people = PEOPLE) {
  vi.spyOn(api, 'getPeople').mockResolvedValue(people);
  return renderWithProviders(<PeoplePage />, { route: '/people', directory });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('People', () => {
  it('groups people you message, people in your channels and people who left', async () => {
    renderPeople();
    const talk = await screen.findByRole('region', { name: /People you message/ });
    const bob = within(talk).getByRole('link', { name: /Bob Brown/ });
    expect(bob.getAttribute('href')).toBe('/people/U2');
    expect(bob.textContent).toContain('Designer');
    expect(bob.textContent).toContain('Talked 2 days ago · 12 direct messages');
    const channels = screen.getByRole('region', { name: /In your channels/ });
    expect(within(channels).getByRole('link', { name: /Carol Diaz/ }).textContent).toContain(
      'Wrote 3 hours ago · 7 messages',
    );
    const left = screen.getByRole('region', { name: /Left the workspace/ });
    expect(within(left).getByRole('link', { name: /Dan/ }).getAttribute('href')).toBe('/people/U4');
  });

  it('filters by name or title; clearing the filter brings everyone back', async () => {
    renderPeople();
    const box = await screen.findByRole('searchbox', { name: 'Filter people' });
    fireEvent.change(box, { target: { value: 'design' } });
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/people/U2']);
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText('No one matches “zzz”.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(screen.getAllByRole('link')).toHaveLength(3);
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: 'carol' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect((box as HTMLInputElement).value).toBe('');
  });

  it('says when there is no one yet', async () => {
    renderPeople([]);
    expect(await screen.findByText('No one here yet')).toBeTruthy();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});
