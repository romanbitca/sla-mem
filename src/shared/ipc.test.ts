import { describe, expect, it } from 'vitest';
import { API_METHODS, ARCHIVE_EVENTS, channelFor, eventChannel } from './ipc';

describe('IPC contract', () => {
  it('lists every method once', () => {
    expect(new Set(API_METHODS).size).toBe(API_METHODS.length);
  });

  it('uses distinct channels for calls and events', () => {
    const calls = API_METHODS.map(channelFor);
    const events = ARCHIVE_EVENTS.map(eventChannel);
    expect(new Set([...calls, ...events]).size).toBe(calls.length + events.length);
  });
});
