import { describe, expect, it } from 'vitest';
import { fileStatusReason } from './dto';

const reason = (download_status: string, download_error: string | null = null, skip_reason: string | null = null) =>
  fileStatusReason({ download_status, download_error, skip_reason } as Parameters<typeof fileStatusReason>[0]);

describe('fileStatusReason (PLAN §8.5)', () => {
  it('says nothing for an archived file', () => {
    expect(reason('done')).toBeNull();
  });

  it('turns stored download errors into plain reasons, never codes', () => {
    const cases: [string, RegExp][] = [
      ['got an HTML page instead of the file (missing files:read scope, or the Slack session expired)', /sign-in page/],
      ['HTTP 403', /refused/],
      ['HTTP 429 (rate limited)', /slow down/],
      ['HTTP 503', /couldn’t send it just now/],
      ['download stalled', /interrupted/],
      ['network error (ECONNRESET)', /interrupted/],
      ['incomplete download (10 of 20 bytes)', /interrupted/],
      ['something nobody expected', /tried again automatically/],
    ];
    for (const [error, expected] of cases) {
      const text = reason('failed', error)!;
      expect(text, error).toMatch(expected);
      expect(text, error).not.toMatch(/\bHTTP\b|\b\d{3}\b|\bECONN|\bscope\b|\bbytes\b|\bhtml\b/i);
    }
  });

  it('keeps the plain reasons written when a file was skipped or became unavailable', () => {
    expect(reason('skipped', 'Larger than 25 MB', 'too_large')).toBe('Larger than 25 MB');
    expect(reason('skipped', null, 'removed')).toBe('Removed to save space');
    expect(reason('unavailable', 'Hidden by Slack’s Free plan')).toBe('Hidden by Slack’s Free plan');
    expect(reason('unavailable')).toBe('No longer available from Slack');
    expect(reason('pending')).toBe('It will be downloaded with the next sync');
  });
});
