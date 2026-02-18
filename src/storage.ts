/**
 * Settings and API key storage for the crush extension.
 *
 * Uses chrome.storage.local — synchronous-looking async API, persists across
 * browser sessions, survives service worker restarts.
 *
 * Two concerns, one module:
 *   - CrushAuthStorage: per-provider API keys
 *   - CrushSettingsManager: user preferences (provider, model, etc.)
 *
 * For testing or non-extension contexts, MemoryStorage implements the same
 * StorageBackend interface in-memory.
 */

// ---------------------------------------------------------------------------
// Settings shape
// ---------------------------------------------------------------------------

export interface CrushSettings {
  selectedProvider?: string;
  selectedModel?: string;
  /** Future: additional preferences */
}

const SETTINGS_KEY = 'crush:settings';
const AUTH_PREFIX = 'crush:auth:';

// ---------------------------------------------------------------------------
// Storage backend abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal key-value storage backend. Matches the shape of chrome.storage.local
 * but is easy to stub.
 */
export interface StorageBackend {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

/** chrome.storage.local adapter */
export class ChromeStorageBackend implements StorageBackend {
  async get(keys: string[]): Promise<Record<string, unknown>> {
    return chrome.storage.local.get(keys);
  }
  async set(items: Record<string, unknown>): Promise<void> {
    await chrome.storage.local.set(items);
  }
  async remove(keys: string[]): Promise<void> {
    await chrome.storage.local.remove(keys);
  }
}

/** In-memory adapter for testing */
export class MemoryStorageBackend implements StorageBackend {
  private data: Record<string, unknown> = {};

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in this.data) result[k] = this.data[k];
    }
    return result;
  }
  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.data, items);
  }
  async remove(keys: string[]): Promise<void> {
    for (const k of keys) delete this.data[k];
  }
}

// ---------------------------------------------------------------------------
// Auth storage
// ---------------------------------------------------------------------------

export class CrushAuthStorage {
  constructor(private backend: StorageBackend) {}

  private keyFor(provider: string): string {
    return AUTH_PREFIX + provider;
  }

  async getApiKey(provider: string): Promise<string | undefined> {
    const key = this.keyFor(provider);
    const result = await this.backend.get([key]);
    return result[key] as string | undefined;
  }

  async setApiKey(provider: string, apiKey: string): Promise<void> {
    await this.backend.set({ [this.keyFor(provider)]: apiKey });
  }

  async removeApiKey(provider: string): Promise<void> {
    await this.backend.remove([this.keyFor(provider)]);
  }

  async hasApiKey(provider: string): Promise<boolean> {
    return (await this.getApiKey(provider)) !== undefined;
  }
}

// ---------------------------------------------------------------------------
// Settings manager
// ---------------------------------------------------------------------------

export class CrushSettingsManager {
  constructor(private backend: StorageBackend) {}

  async getSettings(): Promise<CrushSettings> {
    const result = await this.backend.get([SETTINGS_KEY]);
    return (result[SETTINGS_KEY] as CrushSettings) ?? {};
  }

  async updateSettings(partial: Partial<CrushSettings>): Promise<CrushSettings> {
    const current = await this.getSettings();
    const merged = { ...current, ...partial };
    await this.backend.set({ [SETTINGS_KEY]: merged });
    return merged;
  }

  async getSelectedProvider(): Promise<string | undefined> {
    return (await this.getSettings()).selectedProvider;
  }

  async getSelectedModel(): Promise<string | undefined> {
    return (await this.getSettings()).selectedModel;
  }
}
