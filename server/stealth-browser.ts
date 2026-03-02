/**
 * stealth-browser.ts — Patchright-based browser automation with stealth.
 *
 * Three modes:
 *   1. CDP endpoint: connect to user's browser via SSH reverse tunnel (authenticated sessions)
 *   2. Persistent profile: launch Chromium with a saved profile
 *   3. Fresh launch: launch a clean patchright-managed Chromium
 *
 * All modes return a patchright Page wrapped in HumanBehavior for
 * human-like interaction patterns.
 *
 * For authenticated browser access, the user runs:
 *   ssh -R 9223:localhost:9222 valley-silver.exe.xyz
 * Then connect with: createStealthSession({ cdpEndpoint: 'http://localhost:9223' })
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'patchright';
import { HumanBehavior, type HumanBehaviorConfig } from './human-behavior';
import { CaptchaSolver } from './captcha-solver';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StealthBrowserConfig {
  /** CDP endpoint to connect to (e.g. http://localhost:9223 via SSH tunnel). */
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
 * // User's authenticated browser via SSH tunnel
 * const session = await createStealthSession({ cdpEndpoint: 'http://localhost:9223' });
 *
 * // Fresh stealth launch
 * const session = await createStealthSession({ headless: false });
 * ```
 */
export async function createStealthSession(
  config: StealthBrowserConfig = {},
): Promise<StealthSession> {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;

  if (config.cdpEndpoint) {
    // Mode 1: CDP connection (typically user's browser via SSH reverse tunnel)
    browser = await chromium.connectOverCDP(config.cdpEndpoint);
    const contexts = browser.contexts();
    context = contexts.length > 0 ? contexts[0] : await browser.newContext();
    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  } else if (config.profilePath) {
    // Mode 2: Launch with persistent profile (stealth)
    context = await chromium.launchPersistentContext(config.profilePath, {
      channel: 'chrome',
      headless: config.headless ?? false,
      viewport: config.viewport ?? null,
      // Patchright best practice: don't set custom userAgent or headers
    });
    browser = context.browser()!;
    page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  } else {
    // Mode 3: Launch fresh stealth browser
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
      // Don't close browser in CDP mode — it's the user's browser
      if (!config.cdpEndpoint) {
        await browser.close().catch(() => {});
      }
    },
  };

  return session;
}
