import { describe, expect, it } from 'vitest';

// Every renderer source file as text (the glob is resolved by Vite when the test is built).
const sources = import.meta.glob<string>(['./**/*.{ts,tsx}', '!./**/*.test.{ts,tsx}', '!./test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

describe('renderer security invariants (PLAN §3.6)', () => {
  const files = Object.entries(sources);

  it('scans the whole renderer', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files.some(([file]) => file.includes('lib/mrkdwn/Mrkdwn.tsx'))).toBe(true);
  });

  it('never turns strings into HTML or code', () => {
    for (const [file, src] of files) {
      expect(src, file).not.toMatch(
        /dangerouslySetInnerHTML|\.innerHTML\b|\.outerHTML\b|insertAdjacentHTML|document\.write|\beval\(|new Function\(/,
      );
    }
  });

  it('never embeds other pages or plugins', () => {
    for (const [file, src] of files) {
      expect(src, file).not.toMatch(/<(iframe|webview|object|embed)\b/);
    }
  });

  it('reaches main only through lib/api (the typed, unwrapping client)', () => {
    for (const [file, src] of files) {
      if (file.endsWith('lib/api.ts') || file.endsWith('lib/bridge.ts') || file.endsWith('lib/events.ts')) continue;
      expect(src, file).not.toMatch(/window\.archive|getBridge\(\)\??\.call/);
    }
  });
});
