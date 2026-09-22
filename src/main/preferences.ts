/**
 * Non-secret preferences in `<dataDir>/config.json` (PLAN §3.4). Readable before the database
 * opens, and kept out of the archive so restoring a backup doesn't reset the user's settings.
 * A corrupt file is set aside and defaults are used: preferences must never stop the app starting.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import type {
  AiModel,
  AttachmentPolicy,
  PreferencesDTO,
  PreferencesPatch,
  SyncInterval,
  ThemePreference,
} from '../shared/types';
import { AI_MODELS, SYNC_INTERVALS } from '../shared/types';
import { invalid } from './errors';
import { writeFileAtomicSync } from './fsx';

export const DEFAULT_PREFERENCES: Readonly<PreferencesDTO> = Object.freeze({
  syncIntervalMinutes: 60,
  attachmentPolicy: 'standard',
  overlapDays: 7,
  launchAtLogin: true,
  theme: 'system',
  onboardingComplete: false,
  showTrayIcon: true,
  excludedConversationIds: [],
  aiModel: 'claude-sonnet-5',
});

/** App state that isn't a user preference but must survive restarts. */
export interface InternalState {
  windowBounds?: { x?: number; y?: number; width: number; height: number; maximized?: boolean };
  lastUpdateCheckAt?: number;
  /** The tray balloon explaining "still running in the background" was shown (Windows). */
  trayHintShown?: boolean;
}

interface StoredConfig {
  preferences?: Partial<PreferencesDTO>;
  internal?: InternalState;
}

const POLICIES: readonly AttachmentPolicy[] = ['none', 'standard', 'everything'];
const THEMES: readonly ThemePreference[] = ['system', 'light', 'dark'];

export class Preferences extends EventEmitter {
  private prefs: PreferencesDTO;
  private internal: InternalState;

  constructor(private readonly file: string) {
    super();
    const stored = readConfig(file);
    this.prefs = sanitize(stored.preferences ?? {});
    this.internal = stored.internal ?? {};
  }

  get(): PreferencesDTO {
    return { ...this.prefs };
  }

  /** Validates and saves a patch; emits 'changed' (with the new preferences) when anything changed. */
  update(patch: PreferencesPatch | unknown): PreferencesDTO {
    const clean = validatePatch(patch);
    const next = { ...this.prefs, ...clean };
    const changed = (Object.keys(next) as (keyof PreferencesDTO)[]).some((k) => next[k] !== this.prefs[k]);
    this.prefs = next;
    if (changed) {
      this.save();
      this.emit('changed', this.get());
    }
    return this.get();
  }

  completeOnboarding(launchAtLogin: boolean): PreferencesDTO {
    this.prefs = { ...this.prefs, launchAtLogin, onboardingComplete: true };
    this.save();
    this.emit('changed', this.get());
    return this.get();
  }

  getInternal(): InternalState {
    return { ...this.internal };
  }

  setInternal(patch: Partial<InternalState>): void {
    this.internal = { ...this.internal, ...patch };
    this.save();
  }

  private save(): void {
    const data: StoredConfig = { preferences: this.prefs, internal: this.internal };
    writeFileAtomicSync(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function readConfig(file: string): StoredConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as StoredConfig) : {};
  } catch {
    // Keep the unreadable file for inspection; start from defaults.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // ignore
    }
    return {};
  }
}

/** Stored values that are still valid; anything else falls back to the default. */
function sanitize(p: Partial<PreferencesDTO>): PreferencesDTO {
  const d = DEFAULT_PREFERENCES;
  return {
    syncIntervalMinutes: SYNC_INTERVALS.includes(p.syncIntervalMinutes as SyncInterval)
      ? (p.syncIntervalMinutes as SyncInterval)
      : d.syncIntervalMinutes,
    attachmentPolicy: POLICIES.includes(p.attachmentPolicy as AttachmentPolicy)
      ? (p.attachmentPolicy as AttachmentPolicy)
      : d.attachmentPolicy,
    overlapDays:
      typeof p.overlapDays === 'number' && Number.isInteger(p.overlapDays) && p.overlapDays >= 1 && p.overlapDays <= 60
        ? p.overlapDays
        : d.overlapDays,
    launchAtLogin: typeof p.launchAtLogin === 'boolean' ? p.launchAtLogin : d.launchAtLogin,
    theme: THEMES.includes(p.theme as ThemePreference) ? (p.theme as ThemePreference) : d.theme,
    onboardingComplete: typeof p.onboardingComplete === 'boolean' ? p.onboardingComplete : d.onboardingComplete,
    showTrayIcon: typeof p.showTrayIcon === 'boolean' ? p.showTrayIcon : d.showTrayIcon,
    excludedConversationIds: conversationIds(p.excludedConversationIds) ?? [],
    aiModel: AI_MODELS.includes(p.aiModel as AiModel) ? (p.aiModel as AiModel) : d.aiModel,
  };
}

const CONVERSATION_ID = /^[CDG][A-Z0-9]{2,31}$/;
const MAX_EXCLUDED = 10_000;

/** A clean, de-duplicated list of Slack conversation ids, or null when `v` isn't one. */
function conversationIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length > MAX_EXCLUDED) return null;
  if (!v.every((id) => typeof id === 'string' && CONVERSATION_ID.test(id))) return null;
  return [...new Set(v as string[])].sort();
}

function validatePatch(patch: unknown): PreferencesPatch {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw invalid('Invalid settings');
  const out: PreferencesPatch = {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined) continue;
    switch (key) {
      case 'syncIntervalMinutes':
        if (!SYNC_INTERVALS.includes(value as SyncInterval)) throw invalid('Choose how often to sync from the list');
        out.syncIntervalMinutes = value as SyncInterval;
        break;
      case 'attachmentPolicy':
        if (!POLICIES.includes(value as AttachmentPolicy)) throw invalid('Choose an attachment option from the list');
        out.attachmentPolicy = value as AttachmentPolicy;
        break;
      case 'launchAtLogin':
        if (typeof value !== 'boolean') throw invalid('Invalid “start at login” value');
        out.launchAtLogin = value;
        break;
      case 'theme':
        if (!THEMES.includes(value as ThemePreference)) throw invalid('Invalid theme');
        out.theme = value as ThemePreference;
        break;
      case 'showTrayIcon':
        if (typeof value !== 'boolean') throw invalid('Invalid menu bar icon value');
        out.showTrayIcon = value;
        break;
      case 'excludedConversationIds': {
        const ids = conversationIds(value);
        if (!ids) throw invalid('Invalid list of conversations not to archive');
        out.excludedConversationIds = ids;
        break;
      }
      case 'aiModel':
        if (!AI_MODELS.includes(value as AiModel)) throw invalid('Choose a model from the list');
        out.aiModel = value as AiModel;
        break;
      default:
        throw invalid(`Unknown setting “${key.slice(0, 40)}”`);
    }
  }
  return out;
}
