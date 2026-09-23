import { describe, expect, it } from 'vitest';
import { HISTORY_LIMIT, nextHistory, type NavHistoryState } from './navHistory';

const start: NavHistoryState = { keys: ['a'], at: 0 };

describe('nextHistory', () => {
  it('adds a page, and going somewhere new drops what was ahead', () => {
    let h = nextHistory(start, 'b', 'PUSH');
    h = nextHistory(h, 'c', 'PUSH');
    expect(h).toEqual({ keys: ['a', 'b', 'c'], at: 2 });
    h = nextHistory(h, 'b', 'POP');
    expect(h).toEqual({ keys: ['a', 'b', 'c'], at: 1 });
    h = nextHistory(h, 'd', 'PUSH');
    expect(h).toEqual({ keys: ['a', 'b', 'd'], at: 2 });
  });

  it('keeps its place when a page rewrites its own address', () => {
    const h = nextHistory({ keys: ['a', 'b'], at: 1 }, 'b2', 'REPLACE');
    expect(h).toEqual({ keys: ['a', 'b2'], at: 1 });
    expect(nextHistory(h, 'b2', 'POP')).toBe(h);
  });

  it(`remembers ${HISTORY_LIMIT} steps back at most`, () => {
    let h = start;
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) h = nextHistory(h, `p${i}`, 'PUSH');
    expect(h.keys).toHaveLength(HISTORY_LIMIT + 1);
    expect(h.at).toBe(HISTORY_LIMIT);
    expect(h.keys[0]).toBe('p9');
  });

  it('starts over when the window lands somewhere it didn’t record', () => {
    expect(nextHistory({ keys: ['a', 'b'], at: 1 }, 'zzz', 'POP')).toEqual({ keys: ['zzz'], at: 0 });
  });
});
