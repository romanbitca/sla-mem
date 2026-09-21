/** Which URLs may leave the app for the system browser (PLAN §3.6, §7): http(s) and mailto only. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return EXTERNAL_SCHEMES.has(url.protocol) && (url.protocol === 'mailto:' || url.hostname !== '');
  } catch {
    return false;
  }
}
