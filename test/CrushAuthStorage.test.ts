import { describe, it, expect, beforeEach } from 'vitest';
import { CrushAuthStorage, CrushSettingsManager, MemoryStorageBackend } from '../src/storage.js';

describe('CrushAuthStorage', () => {
  let backend: MemoryStorageBackend;
  let auth: CrushAuthStorage;

  beforeEach(() => {
    backend = new MemoryStorageBackend();
    auth = new CrushAuthStorage(backend);
  });

  describe('key prefixing', () => {
    it('stores keys with crush:auth: prefix', async () => {
      await auth.setApiKey('anthropic', 'sk-test-123');

      // Check raw storage
      const raw = await backend.get(['crush:auth:anthropic']);
      expect(raw['crush:auth:anthropic']).toBe('sk-test-123');
    });

    it('retrieves keys with prefix', async () => {
      await auth.setApiKey('openai', 'sk-openai-key');
      const key = await auth.getApiKey('openai');
      expect(key).toBe('sk-openai-key');
    });

    it('returns undefined for missing keys', async () => {
      const key = await auth.getApiKey('nonexistent');
      expect(key).toBeUndefined();
    });

    it('handles provider names with special characters', async () => {
      await auth.setApiKey('my-provider_v2', 'secret');
      const key = await auth.getApiKey('my-provider_v2');
      expect(key).toBe('secret');
    });
  });

  describe('get/set/delete', () => {
    it('sets and gets an API key', async () => {
      await auth.setApiKey('anthropic', 'sk-ant-123');
      expect(await auth.getApiKey('anthropic')).toBe('sk-ant-123');
    });

    it('overwrites existing key', async () => {
      await auth.setApiKey('anthropic', 'old-key');
      await auth.setApiKey('anthropic', 'new-key');
      expect(await auth.getApiKey('anthropic')).toBe('new-key');
    });

    it('deletes a key', async () => {
      await auth.setApiKey('anthropic', 'sk-ant-123');
      await auth.removeApiKey('anthropic');
      expect(await auth.getApiKey('anthropic')).toBeUndefined();
    });

    it('delete is idempotent', async () => {
      await auth.removeApiKey('nonexistent'); // Should not throw
      await auth.removeApiKey('nonexistent');
    });

    it('hasApiKey returns true when key exists', async () => {
      await auth.setApiKey('anthropic', 'sk-ant-123');
      expect(await auth.hasApiKey('anthropic')).toBe(true);
    });

    it('hasApiKey returns false when key missing', async () => {
      expect(await auth.hasApiKey('anthropic')).toBe(false);
    });
  });

  describe('multiple providers', () => {
    it('stores keys for multiple providers independently', async () => {
      await auth.setApiKey('anthropic', 'sk-ant');
      await auth.setApiKey('openai', 'sk-oai');
      await auth.setApiKey('google', 'sk-goog');

      expect(await auth.getApiKey('anthropic')).toBe('sk-ant');
      expect(await auth.getApiKey('openai')).toBe('sk-oai');
      expect(await auth.getApiKey('google')).toBe('sk-goog');
    });

    it('delete does not affect other providers', async () => {
      await auth.setApiKey('anthropic', 'sk-ant');
      await auth.setApiKey('openai', 'sk-oai');

      await auth.removeApiKey('anthropic');

      expect(await auth.getApiKey('anthropic')).toBeUndefined();
      expect(await auth.getApiKey('openai')).toBe('sk-oai');
    });
  });
});

describe('CrushSettingsManager', () => {
  let backend: MemoryStorageBackend;
  let settings: CrushSettingsManager;

  beforeEach(() => {
    backend = new MemoryStorageBackend();
    settings = new CrushSettingsManager(backend);
  });

  it('returns empty settings when nothing stored', async () => {
    const result = await settings.getSettings();
    expect(result).toEqual({});
  });

  it('updates settings partially', async () => {
    await settings.updateSettings({ selectedProvider: 'anthropic' });
    await settings.updateSettings({ selectedModel: 'claude-3-opus' });

    const result = await settings.getSettings();
    expect(result).toEqual({
      selectedProvider: 'anthropic',
      selectedModel: 'claude-3-opus',
    });
  });

  it('overwrites existing values', async () => {
    await settings.updateSettings({ selectedProvider: 'anthropic' });
    await settings.updateSettings({ selectedProvider: 'openai' });

    expect(await settings.getSelectedProvider()).toBe('openai');
  });

  it('getSelectedProvider returns undefined when not set', async () => {
    expect(await settings.getSelectedProvider()).toBeUndefined();
  });

  it('getSelectedModel returns undefined when not set', async () => {
    expect(await settings.getSelectedModel()).toBeUndefined();
  });
});
