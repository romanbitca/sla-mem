/**
 * Ask AI's Anthropic API key at rest: `<dataDir>/ai-key.bin`, encrypted with Electron's
 * safeStorage exactly like the Slack session (PLAN §3.5). It is never logged and never sent to
 * the window, which only learns whether a key is saved and its last four characters.
 */
import fs from 'node:fs';
import type { SecretCipher } from '../auth';
import { blocked } from '../errors';
import { writeFileAtomicSync } from '../fsx';

export interface AiKeyStore {
  get(): string | null;
  set(key: string): void;
  clear(): void;
}

/** Anthropic API keys start with `sk-ant-`; the rest is letters, digits, `-` and `_`. */
const KEY_RE = /^sk-ant-[A-Za-z0-9_-]{16,300}$/;

export function isAnthropicKey(value: string): boolean {
  return KEY_RE.test(value);
}

export class SafeStorageAiKeyStore implements AiKeyStore {
  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
  ) {}

  get(): string | null {
    let data: Buffer;
    try {
      data = fs.readFileSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (!this.cipher.isEncryptionAvailable()) return null;
    try {
      const key = this.cipher.decryptString(data);
      return isAnthropicKey(key) ? key : null;
    } catch {
      // Written by another OS account or machine (a copied data folder): unusable, not fatal.
      return null;
    }
  }

  set(key: string): void {
    if (!isAnthropicKey(key)) throw new Error('Refusing to store something that is not an Anthropic API key');
    if (!this.cipher.isEncryptionAvailable()) {
      throw blocked(
        'This computer’s secure storage (Keychain / Windows credential protection) isn’t available, so the key can’t be saved safely.',
      );
    }
    writeFileAtomicSync(this.file, this.cipher.encryptString(key), 0o600);
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}

/** In-memory store (tests). */
export class MemoryAiKeyStore implements AiKeyStore {
  constructor(private value: string | null = null) {}
  get(): string | null {
    return this.value;
  }
  set(key: string): void {
    this.value = key;
  }
  clear(): void {
    this.value = null;
  }
}
