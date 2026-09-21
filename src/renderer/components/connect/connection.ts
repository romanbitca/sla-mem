/**
 * Pure helpers for connecting Slack and for the Settings page: labels, choices and form
 * validation, kept separate so the wording is unit-tested in one place.
 */
import type { AttachmentPolicy, AuthMethod, SyncInterval } from '../../../shared/types';

export const METHOD_LABEL: Record<AuthMethod, string> = {
  browser: 'Signed in with Slack',
  cookie: 'Connected with the advanced option',
};

export interface ScheduleOption {
  value: SyncInterval;
  label: string;
}

export const SCHEDULE_OPTIONS: readonly ScheduleOption[] = [
  { value: 0, label: 'Manual only' },
  { value: 15, label: 'Every 15 minutes' },
  { value: 60, label: 'Every hour' },
  { value: 360, label: 'Every 6 hours' },
  { value: 1440, label: 'Daily' },
];

/** "Every hour", or "Every 30 minutes" for a value that isn't one of the choices. */
export function intervalLabel(minutes: number): string {
  const preset = SCHEDULE_OPTIONS.find((o) => o.value === minutes);
  if (preset) return preset.label;
  if (minutes % 1440 === 0) return `Every ${minutes / 1440} days`;
  if (minutes % 60 === 0) return `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

export interface AttachmentOption {
  value: AttachmentPolicy;
  label: string;
  detail: string;
}

/** PLAN §8.4 / §10.4: the middle option keeps the valuable files without runaway videos. */
export const ATTACHMENT_OPTIONS: readonly AttachmentOption[] = [
  {
    value: 'none',
    label: 'Don’t download attachments',
    detail: 'Only messages are saved. Uses the least space.',
  },
  {
    value: 'standard',
    label: 'Images & documents up to 25 MB (recommended)',
    detail: 'Screenshots, photos, PDFs and documents. Videos and very large files are skipped.',
  },
  {
    value: 'everything',
    label: 'Everything up to 200 MB',
    detail: 'Also videos and audio. Uses the most space.',
  },
];

/** "Delete downloaded attachments older than…" choices, in months. */
export const CLEANUP_MONTHS: readonly number[] = [3, 6, 12, 24];

export function monthsLabel(months: number): string {
  if (months % 12 === 0) return months === 12 ? '1 year' : `${months / 12} years`;
  return `${months} months`;
}

/** Where to find the install and user guide (opened in the browser). */
export const GUIDE_URL = 'https://github.com/romanbitca/sla-mem/blob/main/docs/INSTALL.md';

/** The workspace field of the advanced connect form. */
export function validateWorkspace(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Enter your workspace, e.g. 9h.slack.com.';
  if (/(^|\/\/|\.)app\.slack\.com/i.test(value)) {
    return 'Use your workspace’s own address, like 9h.slack.com, not app.slack.com.';
  }
  if (/\s/.test(value)) return 'A workspace address has no spaces, e.g. 9h.slack.com.';
  return null;
}

/** The value pasted in the Advanced form (the only place that names the session cookie). */
export function validateCookie(raw: string): string | null {
  const value = raw.trim();
  if (!value) return 'Paste the value of the d cookie.';
  if (!value.startsWith('xoxd-')) return 'That isn’t the d cookie. Its value starts with “xoxd-”.';
  return null;
}
