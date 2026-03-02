/**
 * stealth-browser.ts — Patchright-based browser automation with stealth.
 *
 * Two modes:
 *   1. Bridge mode: connect to user's real browser via CdpBridge (authenticated sessions)
 *   2. Stealth mode: launch a patchright-managed Chromium (undetectable, fresh profile)
 *
 * Both modes return a patchright Page wrapped in HumanBehavior for
 * human-like interaction patterns.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';
import { HumanBehavior, type HumanBehaviorConfig } from './human-behavior';
import { CaptchaSolver } from './captcha-solver';
import { CdpBridge } from './cdp-bridge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StealthBrowserConfig {
  /** Connect to user's browser via CDP bridge instead of launching a new one. */
  bridge?: CdpBridge;
  /** CDP endpoint to connect to directly (e.g. ws://localhost:9222/devtools/browser/...). */
  cdpEndpoint?: string;
  /** Path to a Chrome profile directory for persistent sessions. */
  profilePath?: string;
  /** Human behavior tuning. */
  humanConfig?: Partial<HumanBehaviorConfig>;
  /** 2captcha API key for CAPTCHA solving. */
  captchaApiKey?: string;
  /** Headless mode (default: false — patchright recommends headed for stealth). */
  headless?: boolean;
  /** Browser viewport size. */
  viewport?: { width: number; height: number } | null;
}

export interface StealthSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  human: HumanBehavior;
  captcha: CaptchaSolver | null;
  /** Navigate to URL with human-like behavior. */
  goto(url: string): Promise<void>;
  /** Close the session. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a stealth browser session.
 *
 * Usage:
 * ```ts
 * // Bridge mode (user's authenticated browser)
 * const session = await createStealthSession({ bridge: myBridge });
 *
 * // Stealth launch mode
 * const session = await createStealthSession({ headless: false });
 *
 * // Direct CDP
 * const session = await createStealthSession({ cdpEndpoint: 'ws://...' });
 * ```
 */
export async function createStealthSession(
  config: StealthBrowserConfig = {},
): Promise<StealthSession> {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  if (config.bridge) {
    // Mode 1: Connect via CDP bridge to user's real browser
    if (!config.bridge.isConnected()) {
      throw new Error('CDP bridge is not connected. Is bridge-client.js running?');
    }
    const endpoint = config.bridge.getEndpoint();
    browser = await chromium.connectOverCDP(endpoint);
    // Use the first existing context (user's default profile) or create one
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  } else if (config.cdpEndpoint) {
    // Mode 2: Direct CDP connection
    browser = await chromium.connectOverCDP(config.cdpEndpoint);
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  } else if (config.profilePath) {
    // Mode 3: Launch with persistent profile (stealth)
    context = await chromium.launchPersistentContext(config.profilePath, {
      channel: 'chrome',
      headless: config.headless ?? false,
      viewport: config.viewport ?? null,
      // Patchright best practice: don't set custom userAgent or headers
    });
    browser = context.browser()!;
    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  } else {
    // Mode 4: Launch fresh stealth browser
    browser = await chromium.launch({
      channel: 'chrome',
      headless: config.headless ?? false,
    });
    context = await browser.newContext({
      viewport: config.viewport ?? null,
    });
    page = await context.newPage();
  }

  const human = new HumanBehavior(page, config.humanConfig);
  const captcha = config.captchaApiKey
    ? new CaptchaSolver(config.captchaApiKey)
    : null;

  const session: StealthSession = {
    browser,
    context,
    page,
    human,
    captcha,

    async goto(url: string): Promise<void> {
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      // Check for CAPTCHAs after navigation
      if (captcha) {
        const detection = await captcha.detect(page);
        if (detection.detected) {
          console.log(`[stealth] CAPTCHA detected: ${detection.type}`);
          const result = await captcha.solve(page, detection);
          if (!result.solved) {
            console.warn(`[stealth] CAPTCHA solve failed: ${result.error}`);
          }
        }
      }
    },

    async close(): Promise<void> {
      await context.close().catch(() => {});
      // Don't close browser in bridge mode — it's the user's browser
      if (!config.bridge && !config.cdpEndpoint) {
        await browser.close().catch(() => {});
      }
    },
  };

  return session;
}
