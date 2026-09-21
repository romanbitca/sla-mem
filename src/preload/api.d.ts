import type { ArchiveBridge } from '../shared/ipc';

declare global {
  interface Window {
    /** Set by the preload script (src/preload/index.ts). */
    archive: ArchiveBridge;
  }
}

export {};
