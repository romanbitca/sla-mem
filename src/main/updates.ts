/**
 * Update check (PLAN §9.5): ask GitHub Releases for the latest version, compare it with this
 * build, and find what this computer needs from it: the installer people download by hand, and
 * the package Slamem installs by itself (Update and restart, see update-install.ts).
 *
 * GitHub answers 404 for private repositories without a token; embedding a token in a shipped app
 * is not acceptable, so the releases must live in a public repository (see README, "Releases").
 */
import type { UpdateInfoDTO } from '../shared/types';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  /** "sha256:<hex>", computed by GitHub when the file was uploaded. */
  digest?: string | null;
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

/** What Update and restart downloads: the macOS zip for this chip, or the Windows installer. */
export interface UpdatePackage {
  version: string;
  name: string;
  url: string;
  size: number;
  /** Hex SHA-256 from the release, checked against the download. */
  sha256: string;
}

/** What GitHub says about the latest release; the update service adds whether it can install it. */
export type ReleaseInfo = Omit<UpdateInfoDTO, 'canInstall' | 'install'>;

export interface ReleaseCheck {
  info: ReleaseInfo;
  /** The package for this computer when a newer release has one. */
  pkg: UpdatePackage | null;
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
): ReleaseInfo {
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

export async function checkForUpdate(opts: UpdateCheckOptions): Promise<ReleaseCheck> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const nothing = (error: string | null) => ({ info: noUpdate(opts.currentVersion, error, now()), pkg: null });
  let res: Response;
  try {
    res = await fetchImpl(`https://api.github.com/repos/${opts.repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sla-mem-update-check' },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return nothing('Couldn’t check for updates (offline?)');
  }
  // A private repository and one without a published release look the same from outside.
  if (res.status === 404)
    return { info: { ...noUpdate(opts.currentVersion, null, now()), noRelease: true }, pkg: null };
  if (!res.ok) return nothing(`Couldn’t check for updates (HTTP ${res.status})`);
  let release: GithubRelease;
  try {
    release = (await res.json()) as GithubRelease;
  } catch {
    return nothing('Couldn’t read the release information');
  }
  return describeRelease(release, opts, now());
}

export function describeRelease(
  release: GithubRelease,
  opts: Pick<UpdateCheckOptions, 'currentVersion' | 'platform' | 'arch'>,
  checkedAt: number | null,
): ReleaseCheck {
  const latest = parseVersion(release.tag_name);
  const current = parseVersion(opts.currentVersion);
  if (!latest || !current || release.draft || release.prerelease) {
    return { info: noUpdate(opts.currentVersion, null, checkedAt), pkg: null };
  }
  const available = compareVersions(latest, current) > 0;
  const assets = release.assets ?? [];
  const version = latest.join('.');
  return {
    info: {
      currentVersion: opts.currentVersion,
      latestVersion: version,
      available,
      notes: release.body?.trim() || null,
      releaseUrl: safeGithubUrl(release.html_url),
      downloadUrl: available ? pickAsset(assets, opts.platform, opts.arch) : null,
      checkedAt,
      error: null,
      noRelease: false,
    },
    pkg: available ? pickPackage(assets, opts.platform, opts.arch, version) : null,
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

/**
 * What Slamem installs by itself: on macOS the .zip of the app for this architecture (never the
 * other one: an Apple Silicon Mac would end up running the Intel build), on Windows the installer.
 * Only with GitHub's SHA-256 of the file, so a damaged download is never installed.
 */
export function pickPackage(
  assets: ReleaseAsset[],
  platform: NodeJS.Platform,
  arch: string,
  version: string,
): UpdatePackage | null {
  let asset: ReleaseAsset | undefined;
  if (platform === 'win32') asset = assets.find((a) => /\.exe$/i.test(a.name));
  else if (platform === 'darwin') {
    const zips = assets.filter((a) => /\.zip$/i.test(a.name));
    asset =
      zips.find((a) => /universal/i.test(a.name)) ??
      (arch === 'arm64' ? zips.find((a) => /arm64/i.test(a.name)) : zips.find((a) => !/arm64|universal/i.test(a.name)));
  }
  const url = asset ? safeGithubUrl(asset.browser_download_url) : null;
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset?.digest ?? '')?.[1]?.toLowerCase();
  const size = asset?.size;
  if (!asset || !url || !sha256 || typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return null;
  return { version, name: asset.name, url, size, sha256 };
}

/** Only links to github.com are ever opened from release data. */
export function safeGithubUrl(raw: string | null | undefined): string | null {
  try {
    const u = new URL(raw ?? '');
    return u.protocol === 'https:' && isGithubHost(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

/** GitHub itself, or where it serves release files from (objects/release-assets.githubusercontent.com). */
export function isGithubHost(hostname: string): boolean {
  return hostname === 'github.com' || hostname.endsWith('.githubusercontent.com');
}
