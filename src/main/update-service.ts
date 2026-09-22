/**
 * Checks for a newer release on launch and then daily (PLAN §9.5), remembering the answer so the
 * banner can be shown without asking GitHub again, and runs Update and restart: download the
 * package, check it, then 'ready'. Main restarts once no sync or import is under way
 * (`restartWhenIdle`) and calls `applyPrepared` as the app exits. 'changed' fires with the new
 * UpdateInfoDTO: a new release, or progress of an update.
 *
 * Whether an update took is decided by the next start: a note written just before the restart
 * says which version was expected (on Windows nothing else reports back from the installer).
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { RunKind, UpdateInfoDTO, UpdateInstallDTO, UpdateInstallState } from '../shared/types';
import { blocked } from './errors';
import type { RunManager } from './runs';
import type { Scheduler } from './scheduler';
import {
  DOWNLOAD_FAILED,
  downloadPackage,
  INSTALL_FAILED,
  UpdateInstallError,
  type ApplyOptions,
  type PreparedUpdate,
  type UpdateInstaller,
} from './update-install';
import { checkForUpdate, noUpdate, type ReleaseCheck } from './updates';

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
  /** Replaces the app with a downloaded version; null where updates are downloaded by hand. */
  installer?: UpdateInstaller | null;
  /** Holds the download until the restart (<dataDir>/tmp/update); emptied on the next start. */
  workDir?: string;
}

/** Written just before restarting: the next start compares it with its own version. */
const PENDING_FILE = 'pending.json';
/** A check soon after an update that didn't take, so Try again and Download can show. */
const RETRY_CHECK_MS = 2_000;

const IDLE: UpdateInstallDTO = { state: 'idle', progress: null, waitingFor: null, error: null };

export class UpdateService extends EventEmitter {
  private latest: ReleaseCheck;
  private install: UpdateInstallDTO = IDLE;
  private prepared: PreparedUpdate | null = null;
  private download: AbortController | null = null;
  private cleanup: Promise<void> = Promise.resolve();
  private unavailable: string | null | undefined;
  private timer: NodeJS.Timeout | null = null;
  private checking: Promise<UpdateInfoDTO> | null = null;

  constructor(private readonly opts: UpdateServiceOptions) {
    super();
    this.latest = { info: noUpdate(opts.currentVersion), pkg: null };
  }

  info(): UpdateInfoDTO {
    return { ...this.latest.info, canInstall: this.canInstall(), install: this.install };
  }

  check(): Promise<UpdateInfoDTO> {
    this.checking ??= checkForUpdate(this.opts)
      .then((result) => {
        const before = this.latest;
        this.latest = result;
        const { info } = result;
        if (info.error) this.log(`Update check: ${info.error}`);
        else if (info.noRelease)
          this.log(`Update check: no published release in ${this.opts.repo} (or it isn't public)`);
        else if (info.available) this.log(`Update available: ${info.latestVersion}`);
        if (
          info.available !== before.info.available ||
          info.latestVersion !== before.info.latestVersion ||
          (result.pkg == null) !== (before.pkg == null)
        ) {
          this.emit('changed', this.info());
        }
        return this.info();
      })
      .finally(() => {
        this.checking = null;
      });
    return this.checking;
  }

  /**
   * Update and restart: starts downloading the new version and returns at once; 'changed' reports
   * progress and 'ready' fires when it is checked and ready to install. Asking again while an
   * update is under way changes nothing.
   */
  installUpdate(): UpdateInfoDTO {
    const { state } = this.install;
    if (state === 'downloading' || state === 'waiting' || state === 'restarting') return this.info();
    const pkg = this.latest.pkg;
    const installer = this.opts.installer;
    const workDir = this.opts.workDir;
    if (!this.canInstall() || !pkg || !installer || !workDir) throw blocked('There’s no update to install.');
    const controller = new AbortController();
    this.download = controller;
    this.setInstall('downloading', { progress: 0 });
    this.log(`Downloading update ${pkg.version} (${pkg.name}, ${pkg.size} bytes)`);
    void (async () => {
      try {
        await this.cleanup;
        await fs.promises.rm(workDir, { recursive: true, force: true });
        const file = await downloadPackage(pkg, workDir, {
          fetch: this.opts.fetch,
          signal: controller.signal,
          onProgress: (progress) => {
            if (!controller.signal.aborted) this.setInstall('downloading', { progress });
          },
        });
        const prepared = await installer.prepare(file, pkg, workDir);
        if (controller.signal.aborted) return;
        this.prepared = prepared;
        this.log(`Update ${pkg.version} downloaded and checked`);
        this.emit('ready', prepared);
      } catch (err) {
        if (controller.signal.aborted) return; // quitting
        const known = err instanceof UpdateInstallError;
        this.log(`Update ${pkg.version} failed: ${known ? err.detail : String(err)}`);
        this.setInstall('failed', { error: known ? err.message : DOWNLOAD_FAILED });
        await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
      } finally {
        if (this.download === controller) this.download = null;
      }
    })();
    return this.info();
  }

  /** Main waits for `kind` to finish before restarting. */
  markWaiting(kind: RunKind): void {
    this.setInstall('waiting', { waitingFor: kind });
  }

  /** Main is quitting to install the update. */
  markRestarting(): void {
    this.setInstall('restarting');
  }

  /**
   * The last step of quitting for an update: notes which version the next start should be, then
   * hands over to the installer, which replaces the app once this process has exited and opens
   * the new version. False when there's nothing to install or it couldn't start (main then
   * reopens the app itself; the next start reports the failure).
   */
  applyPrepared(opts: ApplyOptions): boolean {
    const prepared = this.prepared;
    const { installer, workDir } = this.opts;
    if (!prepared || this.install.state !== 'restarting' || !installer || !workDir) return false;
    this.prepared = null;
    try {
      fs.writeFileSync(
        path.join(workDir, PENDING_FILE),
        JSON.stringify({ from: this.opts.currentVersion, to: prepared.version, at: Date.now() }),
      );
      installer.apply(prepared, opts);
      this.log(`Restarting to install update ${prepared.version}`);
      return true;
    } catch (err) {
      this.log(`Couldn’t start installing update ${prepared.version}: ${String(err)}`);
      return false;
    }
  }

  start(): void {
    const failed = this.finishPreviousUpdate();
    const schedule = (ms: number) => {
      this.timer = setTimeout(() => {
        void this.check().finally(() => schedule(this.opts.intervalMs ?? 24 * 3_600_000));
      }, ms);
      this.timer.unref?.();
    };
    schedule(failed ? RETRY_CHECK_MS : (this.opts.firstCheckMs ?? 30_000));
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.download?.abort();
  }

  private canInstall(): boolean {
    if (!this.latest.info.available || !this.latest.pkg || !this.opts.installer || !this.opts.workDir) return false;
    if (this.unavailable === undefined) {
      this.unavailable = this.opts.installer.unavailableReason();
      if (this.unavailable) this.log(`Updates are downloaded by hand: ${this.unavailable}`);
    }
    return this.unavailable == null;
  }

  /**
   * After a restart for an update: says in the log whether it took, and shows the failure when it
   * didn't. Then empties the download folder. True when the update didn't take.
   */
  private finishPreviousUpdate(): boolean {
    const workDir = this.opts.workDir;
    if (!workDir) return false;
    let failed = false;
    try {
      const pending = JSON.parse(fs.readFileSync(path.join(workDir, PENDING_FILE), 'utf8')) as {
        from?: unknown;
        to?: unknown;
      };
      if (pending.to === this.opts.currentVersion) {
        this.log(`Updated to ${String(pending.to)} (from ${String(pending.from)})`);
      } else if (pending.from === this.opts.currentVersion) {
        this.log(`The update to ${String(pending.to)} didn’t install; still ${this.opts.currentVersion}`);
        this.install = { ...IDLE, state: 'failed', error: INSTALL_FAILED };
        failed = true;
      }
    } catch {
      // No update was being installed.
    }
    // The installer may still be finishing on Windows: whatever is left goes next time.
    this.cleanup = fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    return failed;
  }

  private setInstall(state: UpdateInstallState, patch: Partial<Omit<UpdateInstallDTO, 'state'>> = {}): void {
    this.install = { ...IDLE, ...patch, state };
    this.emit('changed', this.info());
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }
}

/**
 * Restarts for a downloaded update between runs: a sync, attachment download or import that is
 * under way finishes first, and no automatic sync starts meanwhile.
 */
export async function restartWhenIdle(deps: {
  runs: Pick<RunManager, 'activeKind' | 'wait'>;
  scheduler: Pick<Scheduler, 'stop'>;
  updates: Pick<UpdateService, 'markWaiting' | 'markRestarting'>;
  quit: () => void;
}): Promise<void> {
  deps.scheduler.stop();
  for (let kind = deps.runs.activeKind(); kind; kind = deps.runs.activeKind()) {
    deps.updates.markWaiting(kind);
    await deps.runs.wait();
  }
  deps.updates.markRestarting();
  deps.quit();
}
