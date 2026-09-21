/** Slack sign-in, session storage and the archive's connection. */
export { ConnectionService, disconnectedDTO, SIGNED_OUT_MESSAGE, CONNECTION_META_KEY } from './connection';
export type { ResolvedCredentials } from './connection';
export { SafeStorageCredentialStore, MemoryCredentialStore, SecureStorageUnavailableError } from './credentials';
export type { CredentialStore, StoredCredentials, SecretCipher } from './credentials';
export { ConnectError, isExpiredSessionCode, EXPIRED_SESSION_CODES } from './errors';
export { LoginManager, parseLocalConfig } from './signin';
export type { SignInSurface } from './signin';
export { DEFAULT_WEB_ORIGIN } from './origin';
