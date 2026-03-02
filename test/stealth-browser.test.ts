/**
 * Tests for stealth-browser module — unit tests for session creation logic.
 *
 * These test the module's API surface and configuration, not actual browser
 * automation (which requires a real Chromium).
 */

import { describe, it, expect } from 'vitest';
import { createStealthSession, type StealthBrowserConfig } from '../server/stealth-browser';

describe('createStealthSession', () => {
  it('exports the expected interface shape', () => {
    expect(typeof createStealthSession).toBe('function');
  });

  it('config interface accepts all expected fields', () => {
    // Type-level test — if this compiles, the interface is correct
    const config: StealthBrowserConfig = {
      cdpEndpoint: 'http://localhost:9223',
      profilePath: '/tmp/test-profile',
      humanConfig: { typingDelay: [30, 100] },
      captchaApiKey: 'test-key',
      headless: true,
      viewport: { width: 1920, height: 1080 },
    };
    expect(config.cdpEndpoint).toBe('http://localhost:9223');
  });
});
