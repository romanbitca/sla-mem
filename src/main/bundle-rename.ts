/**
 * macOS: the app was called sla-mem until 0.3.2. Update and restart puts a new version exactly
 * where the old one was, so a copy updated from 0.3.0 or 0.3.1 is still "sla-mem.app" in
 * Applications (and in Finder, Launchpad and Spotlight). At its first start, before anything else
 * is loaded, such a copy renames itself "Slamem.app" and opens again from there.
 *
 * Nothing happens unless that is safe: a copy macOS runs from a temporary read-only location, a
 * folder that already holds a Slamem.app, or a rename the system refuses all leave the app as it
 * is, and it starts normally.
 */
import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const APP_BUNDLE_NAME = 'Slamem.app';
const OLD_BUNDLE_NAMES = new Set(['sla-mem.app']);

export interface BundleRename {
  from: string;
  to: string;
}

/** The rename this copy needs, from its executable's path (…/X.app/Contents/MacOS/X), or null. */
export function bundleRenameFor(execPath: string, exists: (p: string) => boolean = fs.existsSync): BundleRename | null {
  const bundle = path.resolve(execPath, '../../..');
  if (!OLD_BUNDLE_NAMES.has(path.basename(bundle))) return null;
  if (bundle.includes('/AppTranslocation/')) return null;
  const to = path.join(path.dirname(bundle), APP_BUNDLE_NAME);
  return exists(to) ? null : { from: bundle, to };
}

/**
 * Runs detached: `sh -c <script> reopen <pid> <app> <open command> [app args…]`. Waits (up to
 * 30 s) for the renamed copy's first process to exit, then opens the app again from its new name.
 */
export const REOPEN_SCRIPT = `pid=$1 app=$2 opener=$3
shift 3
tries=300
while kill -0 "$pid" 2>/dev/null && [ "$tries" -gt 0 ]; do
  tries=$((tries - 1))
  sleep 0.1
done
if [ $# -gt 0 ]; then "$opener" -n "$app" --args "$@"; else "$opener" -n "$app"; fi`;

export interface RenameOptions {
  execPath: string;
  pid: number;
  /** Arguments the app was opened with (an explicit --data-dir), passed on to the new start. */
  args: readonly string[];
  exists?: (p: string) => boolean;
  rename?: (from: string, to: string) => void;
  spawn?: typeof nodeSpawn;
  /** Opens the app afterwards (default /usr/bin/open; tests record instead). */
  opener?: string;
}

/**
 * Renames an old-named bundle and arranges for it to open again: true means this process must
 * exit now, without doing anything else. False (the usual case) means start normally.
 */
export function renameOldBundle(opts: RenameOptions): boolean {
  const plan = bundleRenameFor(opts.execPath, opts.exists);
  if (!plan) return false;
  const rename = opts.rename ?? fs.renameSync;
  try {
    rename(plan.from, plan.to);
  } catch {
    return false; // Not allowed to change that folder: keep the old name.
  }
  const args = opts.args.filter((a) => !a.startsWith('-psn_'));
  try {
    const opener = opts.opener ?? '/usr/bin/open';
    const child = (opts.spawn ?? nodeSpawn)(
      '/bin/sh',
      ['-c', REOPEN_SCRIPT, 'reopen', String(opts.pid), plan.to, opener, ...args],
      { detached: true, stdio: 'ignore' },
    );
    child.unref();
    return true;
  } catch {
    // Nothing would open the app again: put the name back and start as if nothing happened.
    try {
      rename(plan.to, plan.from);
      return false;
    } catch {
      return true; // Can't run from the old path any more; the next start opens Slamem.app.
    }
  }
}
