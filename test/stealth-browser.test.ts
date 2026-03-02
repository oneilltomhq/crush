/**
 * Tests for stealth-browser module — unit tests for session creation logic.
 *
 * These test the module's API surface and configuration, not actual browser
 * automation (which requires a real Chromium).
 */

import { describe, it, expect } from 'vitest';
import { createStealthSession, type StealthBrowserConfig } from '../server/stealth-browser';
import { CdpBridge } from '../server/cdp-bridge';

describe('createStealthSession', () => {
  it('throws when bridge is not connected', async () => {
    const bridge = new CdpBridge();
    // Don't start the bridge — it won't be connected
    await expect(
      createStealthSession({ bridge }),
    ).rejects.toThrow('CDP bridge is not connected');
  });

  it('exports the expected interface shape', () => {
    // Verify the module exports the types we expect
    expect(typeof createStealthSession).toBe('function');
  });

  it('config interface accepts all expected fields', () => {
    // Type-level test — if this compiles, the interface is correct
    const config: StealthBrowserConfig = {
      cdpEndpoint: 'ws://localhost:9222',
      profilePath: '/tmp/test-profile',
      humanConfig: { typingDelay: [30, 100] },
      captchaApiKey: 'test-key',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    };
    expect(config.cdpEndpoint).toBe('ws://localhost:9222');
  });
});
