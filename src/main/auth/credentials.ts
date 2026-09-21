/**
 * The Slack session at rest: `<dataDir>/credentials.bin`, encrypted with Electron's safeStorage,
 * which uses a key held by the OS (Keychain on macOS, DPAPI on Windows) — PLAN §3.5. The file is
 * useless without the OS account that wrote it, and plaintext is never written anywhere.
 */
import fs from 'node:fs';
import type { AuthMethod } from '../../shared/types';
import { writeFileAtomicSync } from '../fsx';

export interface StoredCredentials {
  method: AuthMethod;
  /** xoxc- web session token. */
  token: string;
  /** Value of the `d` cookie (xoxd-…, URL-encoded as the browser stores it). */
  cookie: string;
  teamId: string;
  teamName: string;
  /** e.g. "9h.slack.com" */
  teamDomain: string;
  userId: string;
  userName: string;
  connectedAt: number;
}

/** The parts of Electron's `safeStorage` this module needs (injectable for tests). */
export interface SecretCipher {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface CredentialStore {
  get(): StoredCredentials | null;
  set(credentials: StoredCredentials): void;
  clear(): void;
}

export class SecureStorageUnavailableError extends Error {
  constructor() {
    super(
      'This computer’s secure storage (Keychain / Windows credential protection) isn’t available, so the Slack sign-in can’t be saved safely.',
    );
    this.name = 'SecureStorageUnavailableError';
  }
}

const METHODS: readonly AuthMethod[] = ['browser', 'cookie'];

export class SafeStorageCredentialStore implements CredentialStore {
  constructor(
    private readonly file: string,
    private readonly cipher: SecretCipher,
  ) {}

  get(): StoredCredentials | null {
    let data: Buffer;
    try {
      data = fs.readFileSync(this.file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    if (!this.cipher.isEncryptionAvailable()) throw new SecureStorageUnavailableError();
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.cipher.decryptString(data));
    } catch {
      // Written by another OS account or machine (e.g. a copied archive folder): unusable, not fatal.
      return null;
    }
    return parseCredentials(parsed);
  }

  set(credentials: StoredCredentials): void {
    const clean = parseCredentials(credentials);
    if (!clean) throw new Error('Refusing to store incomplete Slack credentials');
    if (!this.cipher.isEncryptionAvailable()) throw new SecureStorageUnavailableError();
    writeFileAtomicSync(this.file, this.cipher.encryptString(JSON.stringify(clean)), 0o600);
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}

export function parseCredentials(value: unknown): StoredCredentials | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : '');
  if (!METHODS.includes(v.method as AuthMethod) || !/^xox[a-z]-/.test(str('token')) || !str('cookie')) return null;
  return {
    method: v.method as AuthMethod,
    token: str('token'),
    cookie: str('cookie'),
    teamId: str('teamId'),
    teamName: str('teamName'),
    teamDomain: str('teamDomain'),
    userId: str('userId'),
    userName: str('userName'),
    connectedAt: typeof v.connectedAt === 'number' && Number.isFinite(v.connectedAt) ? v.connectedAt : 0,
  };
}

/** In-memory store (tests). */
export class MemoryCredentialStore implements CredentialStore {
  private value: StoredCredentials | null = null;
  get(): StoredCredentials | null {
    return this.value ? { ...this.value } : null;
  }
  set(credentials: StoredCredentials): void {
    this.value = { ...credentials };
  }
  clear(): void {
    this.value = null;
  }
}
