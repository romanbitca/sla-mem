/**
 * Standard (Unicode) emoji shortcodes, as Slack writes them: `smile`, `+1::skin-tone-3`.
 *
 * The ~60 KB shortcode map is code-split and loaded on demand (`loadEmojiMap()`); every lookup is
 * synchronous once it has arrived. Components call `useEmojiMapReady()` so they re-render when it
 * lands; until then unknown shortcodes simply render as `:name:` text.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { buildEmojiTable, splitShortcode, type EmojiMapData, type EmojiTable } from './table';

export { splitShortcode, applySkinTone, type ParsedShortcode, type SkinTone } from './table';

let table: EmojiTable | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Starts (or joins) loading the shortcode map. Resolves once lookups are available. */
export function loadEmojiMap(): Promise<void> {
  if (table) return Promise.resolve();
  pending ??= import('./emoji-map.json')
    .then((mod) => {
      const data = ((mod as { default?: unknown }).default ?? mod) as EmojiMapData;
      table = buildEmojiTable(data);
      for (const listener of listeners) listener();
    })
    .catch((err: unknown) => {
      // Allow a later retry (e.g. a transient chunk-load failure after a deploy).
      pending = null;
      throw err;
    });
  return pending;
}

export function isEmojiMapLoaded(): boolean {
  return table !== null;
}

export function subscribeEmojiMap(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Native emoji for a Slack shortcode, with or without colons and skin tone suffix
 * (`"+1"`, `":+1:"`, `"+1::skin-tone-3"`). Returns undefined for unknown names, custom
 * workspace emoji, or while the map is still loading (loading is kicked off in that case).
 */
export function emojiFromShortcode(name: string): string | undefined {
  if (!table) {
    loadEmojiMap().catch(() => undefined);
    return undefined;
  }
  const parsed = splitShortcode(name);
  return parsed ? table.lookup(parsed.name, parsed.skinTone) : undefined;
}

/** React hook: true once the map is loaded; triggers the load and re-renders when it lands. */
export function useEmojiMapReady(): boolean {
  const ready = useSyncExternalStore(subscribeEmojiMap, isEmojiMapLoaded, isEmojiMapLoaded);
  useEffect(() => {
    if (!ready) loadEmojiMap().catch(() => undefined);
  }, [ready]);
  return ready;
}
