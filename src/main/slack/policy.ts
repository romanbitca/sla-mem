/**
 * Which attachments get downloaded (PLAN §8.4, §10.4–10.5):
 *  - none:       text only;
 *  - standard:   images & documents, i.e. everything except video and audio, up to 25 MB (default:
 *                keeps screenshots and design files, excludes the runaway recordings);
 *  - everything: any file up to 200 MB.
 * Files skipped by the policy stay eligible: they are re-checked on every run, so raising the limit
 * brings them back while Slack still has them.
 */
import type { AttachmentPolicy } from '../../shared/types';
import type { FileRow, FileSkipReason } from '../db';

export const MB = 1024 * 1024;

export interface PolicyRules {
  maxBytes: number;
  excludeMedia: boolean;
}

export const POLICY_RULES: Record<Exclude<AttachmentPolicy, 'none'>, PolicyRules> = {
  standard: { maxBytes: 25 * MB, excludeMedia: true },
  everything: { maxBytes: 200 * MB, excludeMedia: false },
};

export type PolicyDecision =
  { download: true; maxBytes: number } | { download: false; reason: FileSkipReason; detail: string };

export function isMedia(mimetype: string | null | undefined): boolean {
  return /^(video|audio)\//i.test(mimetype ?? '');
}

/** Whether (and up to what size) a file should be downloaded under `policy`. */
export function decideDownload(file: Pick<FileRow, 'mimetype' | 'size'>, policy: AttachmentPolicy): PolicyDecision {
  if (policy === 'none') return { download: false, reason: 'policy', detail: 'Attachment downloads are turned off' };
  const rules = POLICY_RULES[policy];
  if (rules.excludeMedia && isMedia(file.mimetype)) {
    const kind = /^audio\//i.test(file.mimetype ?? '') ? 'Audio' : 'Videos';
    return { download: false, reason: 'policy', detail: `${kind} aren’t downloaded with the recommended setting` };
  }
  if (file.size != null && file.size > rules.maxBytes) {
    return { download: false, reason: 'too_large', detail: `Larger than ${rules.maxBytes / MB} MB` };
  }
  return { download: true, maxBytes: rules.maxBytes };
}
