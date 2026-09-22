// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { useNavigate, type NavigateFunction } from 'react-router';
import type { SearchHit, SearchParams, SearchResponse } from '../../../shared/types';
import { api } from '../../lib/api';
import SearchPage from '../../pages/SearchPage';
import {
  makeConversation,
  makeMessage,
  makeWorkspace,
  renderWithProviders,
  testDirectory,
  testUsers,
  tsAt,
} from '../../test/helpers';
import { MATCH_END, MATCH_START } from './snippet';

const conversations = [
  makeConversation('C1', 'general'),
  makeConversation('C2', 'random'),
  makeConversation('D2', 'Bob', { type: 'im', rawName: null, dmUserId: 'U2' }),
];
const directory = testDirectory(conversations);

function makeHit(i: number): SearchHit {
  const reply = i === 0;
  return {
    message: makeMessage({
      ts: tsAt(i),
      conversationId: i % 2 === 0 ? 'C1' : 'C2',
      userId: 'U2',
      text: `deploy number ${i}`,
      ...(reply ? { threadTs: tsAt(-5), isReply: true } : {}),
    }),
    snippet: `the ${MATCH_START}deploy${MATCH_END} number ${i}`,
  };
}

const HITS = Array.from({ length: 45 }, (_, i) => makeHit(i));

function respond(params: SearchParams): SearchResponse {
  const unresolved = params.q.split(/\s+/).filter((w) => w === 'from:@nobody');
  const offset = params.offset ?? 0;
  const limit = params.limit ?? 30;
  const hits = unresolved.length ? [] : HITS.slice(offset, offset + limit);
  return {
    total: unresolved.length ? 0 : HITS.length,
    hits,
    parsed: {
      text: params.q,
      conversationIds: params.conversation ?? [],
      userIds: params.user ?? [],
      after: params.after ?? null,
      before: params.before ?? null,
      has: params.has ?? [],
      unresolved,
    },
    tookMs: 12.3,
  };
}

let search: MockInstance<typeof api.search>;
let navigate: NavigateFunction;

function NavProbe() {
  navigate = useNavigate();
  return null;
}

beforeEach(() => {
  search = vi.spyOn(api, 'search').mockImplementation(async (params) => respond(params));
  vi.spyOn(api, 'getUsers').mockResolvedValue(testUsers);
  vi.spyOn(api, 'getConversations').mockResolvedValue(conversations);
  vi.spyOn(api, 'getWorkspace').mockResolvedValue(makeWorkspace({ teamName: 'Team', teamDomain: 'team' }));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderAt(route: string) {
  return renderWithProviders(
    <>
      <SearchPage />
      <NavProbe />
    </>,
    { route, directory },
  );
}

const lastParams = () => search.mock.calls[search.mock.calls.length - 1][0];
const input = () => screen.getByRole('combobox', { name: 'Search messages' }) as HTMLInputElement;
const query = (loc: { current: { search: string } | null }) => new URLSearchParams(loc.current!.search);

describe('SearchPage', () => {
  it('shows tips before searching, and a tip starts a query', async () => {
    renderAt('/search');
    expect(screen.getByText('Search everything you’ve archived')).toBeTruthy();
    expect(search).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /from:@name/ }));
    expect(input().value).toBe('from:');
  });

  it('renders hits with highlights, the total and timing', async () => {
    const { container } = renderAt('/search?q=deploy');
    expect(await screen.findByText(/Showing 30 of 45/)).toBeTruthy();
    expect(screen.getByText(/12 ms/)).toBeTruthy();
    expect(lastParams()).toMatchObject({ q: 'deploy', sort: 'relevance', offset: 0, limit: 30 });
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(30);
    expect(marks[0].textContent).toBe('deploy');
    expect(screen.getAllByText('Thread reply')).toHaveLength(1);
    expect(input().value).toBe('deploy');
  });

  it('opens a reply in its thread and a parent at its position', async () => {
    const { container, location } = renderAt('/search?q=deploy');
    await screen.findByText(/Showing 30/);
    const links = container.querySelectorAll<HTMLAnchorElement>('[data-search-hit]');
    expect(links[1].getAttribute('href')).toBe(`/c/C2?ts=${tsAt(1)}`);
    fireEvent.click(links[0]);
    expect(location.current?.pathname).toBe('/c/C1');
    expect(location.current?.search).toBe(`?thread=${tsAt(-5)}&ts=${tsAt(0)}`);
  });

  it('loads more results with the next offset', async () => {
    renderAt('/search?q=deploy');
    fireEvent.click(await screen.findByRole('button', { name: 'Load more results' }));
    expect(await screen.findByText(/Showing 45 of 45/)).toBeTruthy();
    expect(lastParams()).toMatchObject({ q: 'deploy', offset: 30 });
    expect(screen.queryByRole('button', { name: 'Load more results' })).toBeNull();
  });

  it('keeps filters in the URL: has toggles, sort and layout', async () => {
    const { location } = renderAt('/search?q=deploy');
    await screen.findByText(/Showing 30/);

    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    await waitFor(() => expect(query(location).getAll('has')).toEqual(['file']));
    await waitFor(() => expect(lastParams().has).toEqual(['file']));
    expect(screen.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.change(await screen.findByRole('combobox', { name: 'Sort' }), { target: { value: 'newest' } });
    await waitFor(() => expect(query(location).get('sort')).toBe('newest'));

    fireEvent.click(await screen.findByRole('button', { name: 'By conversation' }));
    await waitFor(() => expect(query(location).get('view')).toBe('grouped'));
    expect(screen.getByRole('heading', { name: '#general' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: '#random' })).toBeTruthy();
  });

  it('shows typed modifiers as chips; clearing one removes it from the text', async () => {
    const { location } = renderAt('/search?q=deploy+from%3A%40bob');
    const clear = await screen.findByRole('button', { name: 'Clear From filter' });
    expect(within(clear.parentElement!).getByText('Bob')).toBeTruthy();
    fireEvent.click(clear);
    await waitFor(() => expect(query(location).get('q')).toBe('deploy'));
    expect(query(location).getAll('user')).toEqual([]);
    expect(input().value).toBe('deploy');
  });

  it('edits the person filter through the picker', async () => {
    const { location } = renderAt('/search?q=deploy');
    await screen.findByText(/Showing 30/);
    fireEvent.click(screen.getByRole('button', { name: /^From/ }));
    const dialog = screen.getByRole('dialog', { name: 'From filter' });
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Carol/ }));
    await waitFor(() => expect(query(location).getAll('user')).toEqual(['U3']));
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /Bob/ }));
    await waitFor(() => expect(query(location).getAll('user')).toEqual(['U3', 'U2']));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog', { name: 'From filter' })).toBeNull();

    // Two toggles in one open panel are one history step.
    act(() => void navigate(-1));
    await waitFor(() => expect(query(location).getAll('user')).toEqual([]));
  });

  it('warns about modifiers the server could not resolve, with a fix', async () => {
    const { location } = renderAt('/search?q=deploy+from%3A%40nobody');
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('from:@nobody')).toBeTruthy();
    expect(within(alert).getByText('No one (and no app) in the archive matches this name.')).toBeTruthy();
    expect(screen.queryByText('No messages match')).toBeNull();
    fireEvent.click(within(alert).getByRole('button', { name: 'Remove from:@nobody' }));
    await waitFor(() => expect(query(location).get('q')).toBe('deploy'));
    expect(await screen.findByText(/Showing 30 of 45/)).toBeTruthy();
  });

  it('shows a no-results state with a way out of filters', async () => {
    search.mockImplementation(async (params) => ({ ...respond(params), total: 0, hits: [] }));
    const { location } = renderAt('/search?q=zzz&has=image');
    expect(await screen.findByText('No messages match')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search without filters' }));
    await waitFor(() => expect(query(location).getAll('has')).toEqual([]));
    expect(query(location).get('q')).toBe('zzz');
  });

  it('autocompletes a modifier and searches on submit', async () => {
    const { location } = renderAt('/search?q=deploy');
    await screen.findByText(/Showing 30/);
    const box = input();
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: 'deploy from:ca' } });
    const listbox = await screen.findByRole('listbox', { name: 'People' });
    expect(within(listbox).getByRole('option', { name: /Carol/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('deploy from:@carol ');
    fireEvent.submit(box.closest('form')!);
    await waitFor(() => expect(query(location).get('q')).toBe('deploy from:@carol'));
    expect(await screen.findByRole('button', { name: 'Clear From filter' })).toBeTruthy();
  });

  it('starts over when the box is cleared: no results, filters or sort, as if just opened', async () => {
    const { location } = renderAt('/search?q=deploy&has=file&sort=newest&view=grouped');
    await screen.findByText(/Showing 30/);
    fireEvent.click(screen.getByRole('button', { name: 'Clear search text' }));
    await waitFor(() => expect(location.current?.search).toBe(''));
    expect(location.current?.pathname).toBe('/search');
    expect(input().value).toBe('');
    expect(screen.getByText('Search everything you’ve archived')).toBeTruthy();
    expect(screen.queryByText(/Showing/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Files' }).getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(input());
    // Back brings the cleared search back.
    act(() => void navigate(-1));
    await waitFor(() => expect(input().value).toBe('deploy'));
    expect(await screen.findByText(/Showing 30/)).toBeTruthy();
  });

  it('clears a query that was typed but not searched yet, and nothing else', async () => {
    const { location } = renderAt('/search');
    fireEvent.change(input(), { target: { value: 'half typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Clear search text' }));
    expect(input().value).toBe('');
    expect(location.current?.search).toBe('');
    expect(search).not.toHaveBeenCalled();
  });

  it('tags old results “Archive only”, except notes to yourself (Slack keeps those)', async () => {
    const old = (conversationId: string, i: number) => ({
      message: makeMessage({ ts: tsAt(i), conversationId, userId: 'U1', text: `note ${i}` }),
      snippet: `${MATCH_START}note${MATCH_END} ${i}`,
    });
    search.mockImplementation(async (params) => ({
      ...respond(params),
      total: 2,
      hits: [old('C1', 1), old('D1', 2)],
    }));
    const notes = makeConversation('D1', 'You', { type: 'im', rawName: null, dmUserId: 'U1' });
    vi.spyOn(api, 'getConversations').mockResolvedValue([...conversations, notes]);
    const { container } = renderWithProviders(<SearchPage />, {
      route: '/search?q=note',
      directory: testDirectory([...conversations, notes]),
    });
    await screen.findByText(/Showing 2 of 2/);
    const [channel, self] = container.querySelectorAll<HTMLElement>('[data-search-hit]');
    expect(within(channel).queryByText('Archive only')).toBeTruthy();
    expect(within(self).queryByText('Archive only')).toBeNull();
  });

  it('follows back/forward: the URL is the source of truth', async () => {
    renderAt('/search?q=deploy');
    await screen.findByText(/Showing 30/);
    fireEvent.change(input(), { target: { value: 'release' } });
    fireEvent.keyDown(input(), { key: 'Enter' }); // no suggestion open: Enter searches
    await waitFor(() => expect(lastParams().q).toBe('release'));
    act(() => void navigate(-1));
    await waitFor(() => expect(input().value).toBe('deploy'));
    act(() => void navigate(1));
    await waitFor(() => expect(input().value).toBe('release'));
  });

  it('draws emoji shortcodes in snippets, highlighting a matched one whole', async () => {
    search.mockImplementation(async (params) => ({
      ...respond(params),
      total: 1,
      hits: [
        {
          message: makeMessage({ ts: tsAt(1), userId: 'U2', text: ':warning: :tada: shipped' }),
          snippet: `:warning: :${MATCH_START}tada${MATCH_END}: shipped at 10:30:45`,
        },
      ],
    }));
    const { container } = renderAt('/search?q=tada');
    await screen.findByText(/Showing 1 of 1/);
    const glyphs = [...container.querySelectorAll('span.md-emoji')].map((e) => e.textContent);
    expect(glyphs).toEqual(['⚠️', '🎉']);
    expect(container.querySelector('mark span.md-emoji')?.textContent).toBe('🎉');
    expect(container.textContent).toContain('shipped at 10:30:45');
  });

  it('keeps a from: value that isn’t a person (an app) as query text, not a chip', async () => {
    const { location } = renderAt('/search?q=deploy+from%3AGitHub');
    await screen.findByText(/Showing 30/);
    expect(lastParams().q).toBe('deploy from:GitHub');
    expect(screen.queryByRole('button', { name: 'Clear From filter' })).toBeNull();
    // Editing people keeps the app filter typed in the query.
    fireEvent.click(screen.getByRole('button', { name: /^From/ }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'From filter' })).getByRole('checkbox', { name: /Carol/ }),
    );
    await waitFor(() => expect(query(location).getAll('user')).toEqual(['U3']));
    expect(query(location).get('q')).toBe('deploy from:GitHub');
  });
});
