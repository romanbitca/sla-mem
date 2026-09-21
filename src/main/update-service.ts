/**
 * Checks for a newer release on launch and then daily (PLAN §9.5), remembering the answer so the
 * banner can be shown without asking GitHub again. 'changed' fires with the new UpdateInfoDTO.
 */
import { EventEmitter } from 'node:events';
import type { UpdateInfoDTO } from '../shared/types';
import { checkForUpdate, noUpdate } from './updates';

export interface UpdateServiceOptions {
  repo: string;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch?: typeof fetch;
  /** First check this long after start (default 30 s), then every `intervalMs` (default 24 h). */
  firstCheckMs?: number;
  intervalMs?: number;
  log?: (line: string) => void;
}

export class UpdateService extends EventEmitter {
  private latest: UpdateInfoDTO;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<UpdateInfoDTO> | null = null;

  constructor(private readonly opts: UpdateServiceOptions) {
    super();
    this.latest = noUpdate(opts.currentVersion);
  }

  info(): UpdateInfoDTO {
    return this.latest;
  }

  check(): Promise<UpdateInfoDTO> {
    this.checking ??= checkForUpdate(this.opts)
      .then((info) => {
        const changed = info.available !== this.latest.available || info.latestVersion !== this.latest.latestVersion;
        this.latest = info;
        if (info.error) this.opts.log?.(`Update check: ${info.error}`);
        else if (info.available) this.opts.log?.(`Update available: ${info.latestVersion}`);
        if (changed) this.emit('changed', info);
        return info;
      })
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  start(): void {
    const schedule = (ms: number) => {
      this.timer = setTimeout(() => {
        void this.check().finally(() => schedule(this.opts.intervalMs ?? 24 * 3_600_000));
      }, ms);
      this.timer.unref?.();
    };
    schedule(this.opts.firstCheckMs ?? 30_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
