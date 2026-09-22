/**
 * Update check (PLAN §9.5 baseline): ask GitHub Releases for the latest version, compare it with
 * this build, and offer the right download for this computer. Nothing is installed automatically —
 * unsigned macOS builds can't be swapped silently — the user downloads and replaces the app.
 *
 * GitHub answers 404 for private repositories without a token; embedding a token in a shipped app
 * is not acceptable, so the releases must live in a public repository (see README, "Releases").
 */
import type { UpdateInfoDTO } from '../shared/types';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
}

export interface GithubRelease {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  html_url: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
}

export interface UpdateCheckOptions {
  /** "owner/repo" */
  repo: string;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export function noUpdate(
  currentVersion: string,
  error: string | null = null,
  checkedAt: number | null = null,
): UpdateInfoDTO {
  return {
    currentVersion,
    latestVersion: null,
    available: false,
    notes: null,
    releaseUrl: null,
    downloadUrl: null,
    checkedAt,
    error,
    noRelease: false,
  };
}

export async function checkForUpdate(opts: UpdateCheckOptions): Promise<UpdateInfoDTO> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${opts.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sla-mem-update-check' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return noUpdate(opts.currentVersion, 'Couldn’t check for updates (offline?)', now());
  }
  // A private repository and one without a published release look the same from outside.
  if (res.status === 404) return { ...noUpdate(opts.currentVersion, null, now()), noRelease: true };
  if (!res.ok) return noUpdate(opts.currentVersion, `Couldn’t check for updates (HTTP ${res.status})`, now());
  let release: GithubRelease;
  try {
    release = (await res.json()) as GithubRelease;
  } catch {
    return noUpdate(opts.currentVersion, 'Couldn’t read the release information', now());
  }
  return describeRelease(release, opts, now());
}

export function describeRelease(
  release: GithubRelease,
  opts: Pick<UpdateCheckOptions, 'currentVersion' | 'platform' | 'arch'>,
  checkedAt: number | null,
): UpdateInfoDTO {
  const latest = parseVersion(release.tag_name);
  const current = parseVersion(opts.currentVersion);
  if (!latest || !current || release.draft || release.prerelease) return noUpdate(opts.currentVersion, null, checkedAt);
  const available = compareVersions(latest, current) > 0;
  return {
    currentVersion: opts.currentVersion,
    latestVersion: latest.join('.'),
    available,
    notes: release.body?.trim() || null,
    releaseUrl: safeGithubUrl(release.html_url),
    downloadUrl: available ? pickAsset(release.assets ?? [], opts.platform, opts.arch) : null,
    checkedAt,
    error: null,
    noRelease: false,
  };
}

/** "v1.2.3" / "1.2.3" → [1, 2, 3]; anything else (pre-releases, garbage) → null. */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((v ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/**
 * The installer for this computer: the NSIS .exe on Windows; on macOS the .dmg for this
 * architecture (Apple Silicon builds are named *-arm64.dmg).
 */
export function pickAsset(assets: ReleaseAsset[], platform: NodeJS.Platform, arch: string): string | null {
  const url = (a: ReleaseAsset | undefined) => (a ? safeGithubUrl(a.browser_download_url) : null);
  if (platform === 'win32') return url(assets.find((a) => /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name)));
  if (platform === 'darwin') {
    const dmgs = assets.filter((a) => /\.dmg$/i.test(a.name));
    const arm = dmgs.find((a) => /arm64/i.test(a.name));
    const intel = dmgs.find((a) => !/arm64/i.test(a.name));
    const universal = dmgs.find((a) => /universal/i.test(a.name));
    return url(universal ?? (arch === 'arm64' ? (arm ?? intel) : (intel ?? arm)));
  }
  return null;
}

/** Only links to github.com are ever opened from release data. */
function safeGithubUrl(raw: string | null | undefined): string | null {
  try {
    const u = new URL(raw ?? '');
    return u.protocol === 'https:' && (u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'))
      ? u.href
      : null;
  } catch {
    return null;
  }
}
