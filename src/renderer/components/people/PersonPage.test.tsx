// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import type { PersonDTO } from '../../../shared/types';
import { api, ApiError } from '../../lib/api';
import { buildDirectory } from '../../lib/directory';
import PersonPage from '../../pages/PersonPage';
import {
  makeConversation,
  makeFile,
  makeImage,
  makeMessage,
  makePerson,
  makeUser,
  renderWithProviders,
  tsAt,
} from '../../test/helpers';
import { WeekBars } from './WeekBars';

const directory = buildDirectory(
  [makeUser('U1', 'Me', { name: 'me' }), makeUser('U2', 'Bob Brown', { name: 'bob' }), makeUser('U3', 'Carol')],
  [
    makeConversation('D2', 'Bob Brown', { type: 'im', dmUserId: 'U2', rawName: null }),
    makeConversation('M1', 'Bob Brown, Carol', { type: 'mpim', rawName: null, memberIds: ['U1', 'U2', 'U3'] }),
    ...['general', 'design', 'eng', 'ops', 'sales', 'random', 'hiring'].map((name, i) =>
      makeConversation(`C${i}`, name, { type: i === 1 ? 'private_channel' : 'channel' }),
    ),
  ],
  {},
  'U1',
  '9h',
);

const ASK = makeMessage({ ts: tsAt(10), conversationId: 'D2', userId: 'U2', text: 'can you send the file?' });
const MINE = makeMessage({ ts: tsAt(11), conversationId: 'C0', userId: 'U1', text: '<@U2> any update on the logo?' });

const BOB: PersonDTO = makePerson('U2', {
  title: 'Designer',
  tz: 'UTC',
  email: 'bob@example.com',
  messageCount: 40,
  firstMessageTs: tsAt(0),
  lastMessageTs: tsAt(20),
  lastTalkedTs: tsAt(20),
  dm: { conversationId: 'D2', messageCount: 12, latestTs: tsAt(20) },
  groupDms: [{ conversationId: 'M1', messageCount: 5, latestTs: tsAt(15) }],
  channels: ['C0', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((id, i) => ({
    conversationId: id,
    messageCount: 20 - i,
    latestTs: tsAt(i),
  })),
  weeks: [
    { start: 1_700_000_000, count: 3 },
    { start: 1_700_604_800, count: 0 },
    { start: 1_701_209_600, count: 9 },
  ],
  waitingOnYou: [ASK],
  waitingOnThem: [MINE],
  recent: [makeMessage({ ts: tsAt(20), conversationId: 'D2', userId: 'U2', text: 'see you tomorrow' })],
  fileMessages: [
    makeMessage({
      ts: tsAt(5),
      conversationId: 'C0',
      userId: 'U2',
      files: [makeImage({ id: 'F1', title: 'logo.png' }), makeFile({ id: 'F2', name: 'brief.pdf', filetype: 'pdf' })],
    }),
  ],
  links: [
    {
      url: 'https://docs.example.com/spec/v2',
      label: 'the spec',
      conversationId: 'C0',
      ts: tsAt(6),
      threadTs: null,
      isReply: false,
    },
    {
      url: 'https://www.figma.com/file/abc',
      label: null,
      conversationId: 'D2',
      ts: tsAt(7),
      threadTs: null,
      isReply: false,
    },
  ],
});

function renderPerson(result: PersonDTO | Error = BOB, route = '/people/U2') {
  if (result instanceof Error) vi.spyOn(api, 'getPerson').mockRejectedValue(result);
  else vi.spyOn(api, 'getPerson').mockResolvedValue(result);
  return renderWithProviders(
    <Routes>
      <Route path="people/:id" element={<PersonPage />} />
      <Route path="*" element={null} />
    </Routes>,
    { route, directory },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('A person’s page', () => {
  it('says who they are, with ways to reach what’s between you', async () => {
    renderPerson();
    // The header names them from the directory at once; the rest arrives with their page.
    expect(screen.getByRole('heading', { level: 1, name: 'Bob Brown' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'People' }).getAttribute('href')).toBe('/people');
    expect(await screen.findByText('Designer · @bob')).toBeTruthy();
    expect(screen.getByText(/local time/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'bob@example.com' }).getAttribute('href')).toBe('mailto:bob@example.com');
    expect(screen.getByRole('link', { name: 'Open DM' }).getAttribute('href')).toBe('/c/D2');
    expect(screen.getByRole('link', { name: 'Their messages' }).getAttribute('href')).toBe('/search?q=from%3A%40bob');
    expect(screen.getByRole('link', { name: 'Open in Slack' }).getAttribute('href')).toBe(
      'https://9h.slack.com/archives/D2',
    );
    const facts = screen.getByText('Direct messages', { selector: 'dt' }).closest('dl')!;
    expect(facts.textContent).toContain('12');
    expect(facts.textContent).toContain('Their messages40');
  });

  it('lists the open questions both ways, and the latest between you', async () => {
    renderPerson();
    const open = await screen.findByRole('region', { name: 'Open questions' });
    expect(within(open).getByText('Bob asked you')).toBeTruthy();
    expect(within(open).getByText('You asked Bob')).toBeTruthy();
    const ask = within(open).getByRole('link', { name: /can you send the file/ });
    expect(ask.getAttribute('href')).toBe(`/c/D2?ts=${tsAt(10)}`);
    const recent = screen.getByRole('region', { name: 'Recent between you' });
    expect(within(recent).getByRole('link', { name: /see you tomorrow/ })).toBeTruthy();
  });

  it('says so when nothing is open', async () => {
    renderPerson({ ...BOB, waitingOnYou: [], waitingOnThem: [] });
    expect(await screen.findByText('No open questions between you in the last 30 days.')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Open questions' })).toBeNull();
  });

  it('shows where you talk; their channels open their messages there, the rest a click away', async () => {
    renderPerson();
    const places = await screen.findByRole('region', { name: 'Where you talk' });
    expect(
      within(places)
        .getByRole('link', { name: /Direct messages/ })
        .getAttribute('href'),
    ).toBe('/c/D2');
    expect(
      within(places)
        .getByRole('link', { name: /With Carol/ })
        .getAttribute('href'),
    ).toBe('/c/M1');
    const general = within(places).getByRole('link', { name: /general/ });
    expect(general.getAttribute('href')).toBe(`/search?q=${encodeURIComponent('from:@bob in:#general')}`);
    expect(general.getAttribute('title')).toBe('Bob’s messages in #general');
    expect(within(places).queryByRole('link', { name: /hiring/ })).toBeNull();
    fireEvent.click(within(places).getByRole('button', { name: 'Show all 7' }));
    expect(within(places).getByRole('link', { name: /hiring/ })).toBeTruthy();
  });

  it('shows what they shared: images and files open their message, links open in the browser', async () => {
    renderPerson();
    const shared = await screen.findByRole('region', { name: 'Shared by Bob' });
    expect(within(shared).getByRole('img', { name: 'logo.png' }).closest('a')?.getAttribute('href')).toBe(
      `/c/C0?ts=${tsAt(5)}`,
    );
    expect(
      within(shared)
        .getByRole('link', { name: /brief\.pdf/ })
        .getAttribute('href'),
    ).toBe(`/c/C0?ts=${tsAt(5)}`);
    const spec = within(shared).getByRole('link', { name: /the spec/ });
    expect(spec.getAttribute('href')).toBe('https://docs.example.com/spec/v2');
    expect(spec.getAttribute('target')).toBe('_blank');
    expect(within(shared).getByRole('link', { name: 'figma.com/file/abc' })).toBeTruthy();
    expect(within(shared).getByRole('link', { name: 'All files' }).getAttribute('href')).toBe(
      `/search?q=${encodeURIComponent('from:@bob has:file')}`,
    );
  });

  it('“Brief me” opens Ask AI with a question about them, not yet sent', async () => {
    const askAi = vi.spyOn(api, 'askAi');
    const { location } = renderPerson();
    fireEvent.click(await screen.findByRole('button', { name: 'Brief me' }));
    expect(location.current?.pathname).toBe('/ask');
    expect((location.current?.state as { askDraft: string }).askDraft).toMatch(/^Brief me on Bob Brown \(@bob\)/);
    expect(askAi).not.toHaveBeenCalled();
  });

  it('on your own page: what you wrote and shared, nothing to brief or answer', async () => {
    renderPerson(makePerson('U1', { isSelf: true, messageCount: 5, channels: BOB.channels.slice(0, 1) }), '/people/U1');
    expect(await screen.findByText('You')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Brief me' })).toBeNull();
    expect(screen.queryByText(/open questions/i)).toBeNull();
    expect(screen.getByRole('link', { name: 'Your messages' }).getAttribute('href')).toBe('/search?q=from%3Ame');
    expect(screen.getByRole('region', { name: 'Where you write' })).toBeTruthy();
  });

  it('says when someone isn’t in the archive', async () => {
    renderPerson(new ApiError('not_found', 'That person isn’t in the archive.'), '/people/UNOBODY');
    expect(await screen.findByText('That person isn’t in the archive')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'All people' }).getAttribute('href')).toBe('/people');
  });
});

describe('WeekBars', () => {
  it('tells each week on focus, moving with the arrow keys from a single tab stop', () => {
    renderWithProviders(<WeekBars weeks={BOB.weeks} />);
    const bars = screen.getAllByRole('img');
    expect(bars.map((b) => b.tabIndex)).toEqual([-1, -1, 0]);
    expect(bars[2].getAttribute('aria-label')).toMatch(/: 9 messages$/);
    bars[2].focus();
    fireEvent.keyDown(bars[2], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(bars[1]);
    fireEvent.keyDown(bars[1], { key: 'Home' });
    expect(document.activeElement).toBe(bars[0]);
    expect(screen.getByText(/12 messages in 3 weeks · busiest: the week of/)).toBeTruthy();
    expect(screen.getByRole('table', { hidden: true })).toBeTruthy();
  });
});
