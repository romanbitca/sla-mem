/**
 * Copies text, falling back to a hidden textarea where the async Clipboard API refuses (it needs
 * a focused document and the clipboard-write permission, which main grants to the app window).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or not focused: try the legacy path.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = typeof document.execCommand === 'function' && document.execCommand('copy');
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}
