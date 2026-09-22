import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SecretCipher } from '../auth';
import { isAnthropicKey, SafeStorageAiKeyStore } from './key-store';

const KEY = 'sk-ant-api03-Zyx_wvu-9876543210abcdefghij';

/** Reversible stand-in for the OS keychain: proves the key never reaches the disk as text. */
const cipher: SecretCipher = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a)),
  decryptString: (b) => Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8'),
};

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sla-mem-ai-key-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('the Ask AI key at rest', () => {
  it('is stored encrypted, owner-only, and read back', () => {
    const file = path.join(dir, 'ai-key.bin');
    const store = new SafeStorageAiKeyStore(file, cipher);
    expect(store.get()).toBeNull();
    store.set(KEY);
    expect(fs.readFileSync(file).toString('utf8')).not.toContain('sk-ant');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new SafeStorageAiKeyStore(file, cipher).get()).toBe(KEY);
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('treats a file it can’t read (another computer, no keychain) as no key', () => {
    const file = path.join(dir, 'ai-key.bin');
    new SafeStorageAiKeyStore(file, cipher).set(KEY);
    const other: SecretCipher = { ...cipher, decryptString: () => 'garbage' };
    expect(new SafeStorageAiKeyStore(file, other).get()).toBeNull();
    const locked: SecretCipher = { ...cipher, isEncryptionAvailable: () => false };
    expect(new SafeStorageAiKeyStore(file, locked).get()).toBeNull();
    expect(() => new SafeStorageAiKeyStore(file, locked).set(KEY)).toThrow(/secure storage/);
  });

  it('accepts only Anthropic API keys', () => {
    expect(isAnthropicKey(KEY)).toBe(true);
    expect(isAnthropicKey('sk-ant-short')).toBe(false);
    expect(isAnthropicKey('sk-proj-abcdefghijklmnopqrstuvwxyz')).toBe(false);
    expect(isAnthropicKey(`${KEY} `)).toBe(false);
  });
});
