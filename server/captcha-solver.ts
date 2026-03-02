/**
 * captcha-solver.ts — Detect and solve CAPTCHAs during browser automation.
 *
 * Uses the 2captcha service to solve reCAPTCHA v2/v3, hCaptcha,
 * Cloudflare Turnstile, and generic image CAPTCHAs.
 */

import { type Page } from 'patchright';
import { Solver } from '2captcha-ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CaptchaType =
  | 'recaptcha-v2'
  | 'recaptcha-v3'
  | 'hcaptcha'
  | 'cloudflare-turnstile'
  | 'image-captcha';

export interface CaptchaDetection {
  detected: boolean;
  type: CaptchaType | null;
  siteKey?: string;
}

export interface CaptchaSolveResult {
  solved: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// CaptchaSolver
// ---------------------------------------------------------------------------

export class CaptchaSolver {
  private solver: Solver;

  constructor(apiKey: string) {
    this.solver = new Solver(apiKey);
  }

  // -----------------------------------------------------------------------
  // Detection
  // -----------------------------------------------------------------------

  /**
   * Inspect the current page for common CAPTCHA types.
   * Returns the first match found (checked in priority order).
   */
  async detect(page: Page): Promise<CaptchaDetection> {
    const none: CaptchaDetection = { detected: false, type: null };

    // --- reCAPTCHA v2 ---------------------------------------------------
    const recaptchaV2 = await this.detectRecaptchaV2(page);
    if (recaptchaV2) return recaptchaV2;

    // --- reCAPTCHA v3 ---------------------------------------------------
    const recaptchaV3 = await this.detectRecaptchaV3(page);
    if (recaptchaV3) return recaptchaV3;

    // --- hCaptcha -------------------------------------------------------
    const hcaptcha = await this.detectHCaptcha(page);
    if (hcaptcha) return hcaptcha;

    // --- Cloudflare Turnstile -------------------------------------------
    const turnstile = await this.detectTurnstile(page);
    if (turnstile) return turnstile;

    // --- Generic image CAPTCHA ------------------------------------------
    const image = await this.detectImageCaptcha(page);
    if (image) return image;

    return none;
  }

  private async detectRecaptchaV2(page: Page): Promise<CaptchaDetection | null> {
    const siteKey = await page.evaluate(() => {
      const widget = document.querySelector('.g-recaptcha');
      if (widget) return widget.getAttribute('data-sitekey') ?? '';

      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe[src*="recaptcha"]',
      );
      if (iframe) {
        const m = iframe.src.match(/[?&]k=([^&]+)/);
        return m ? m[1] : '';
      }

      return null;
    });

    if (siteKey === null) return null;
    return { detected: true, type: 'recaptcha-v2', siteKey: siteKey || undefined };
  }

  private async detectRecaptchaV3(page: Page): Promise<CaptchaDetection | null> {
    const result = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script'));
      for (const s of scripts) {
        const text = s.textContent ?? '';
        if (text.includes('grecaptcha.execute')) {
          const keyMatch = text.match(
            /grecaptcha\.execute\s*\(\s*['"]([^'"]+)['"]/,
          );
          return { found: true, siteKey: keyMatch ? keyMatch[1] : '' };
        }
      }

      // Also check for render=<key> in script srcs
      for (const s of scripts) {
        const src = s.getAttribute('src') ?? '';
        if (src.includes('recaptcha') && src.includes('render=')) {
          const m = src.match(/render=([^&]+)/);
          if (m && m[1] !== 'explicit') {
            return { found: true, siteKey: m[1] };
          }
        }
      }

      return { found: false, siteKey: '' };
    });

    if (!result.found) return null;
    return {
      detected: true,
      type: 'recaptcha-v3',
      siteKey: result.siteKey || undefined,
    };
  }

  private async detectHCaptcha(page: Page): Promise<CaptchaDetection | null> {
    const siteKey = await page.evaluate(() => {
      const widget = document.querySelector('.h-captcha');
      if (widget) return widget.getAttribute('data-sitekey') ?? '';

      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe[src*="hcaptcha"]',
      );
      if (iframe) {
        const m = iframe.src.match(/sitekey=([^&]+)/);
        return m ? m[1] : '';
      }

      return null;
    });

    if (siteKey === null) return null;
    return { detected: true, type: 'hcaptcha', siteKey: siteKey || undefined };
  }

  private async detectTurnstile(page: Page): Promise<CaptchaDetection | null> {
    const siteKey = await page.evaluate(() => {
      const widget = document.querySelector('.cf-turnstile');
      if (widget) return widget.getAttribute('data-sitekey') ?? '';

      const iframe = document.querySelector<HTMLIFrameElement>(
        'iframe[src*="challenges.cloudflare.com"]',
      );
      if (iframe) {
        const m = iframe.src.match(/sitekey=([^&]+)/);
        return m ? m[1] : '';
      }

      return null;
    });

    if (siteKey === null) return null;
    return {
      detected: true,
      type: 'cloudflare-turnstile',
      siteKey: siteKey || undefined,
    };
  }

  private async detectImageCaptcha(page: Page): Promise<CaptchaDetection | null> {
    const found = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const captchaPattern = /captcha/i;

      for (const input of inputs) {
        const name = input.getAttribute('name') ?? '';
        const id = input.getAttribute('id') ?? '';
        const placeholder = input.getAttribute('placeholder') ?? '';

        if (
          captchaPattern.test(name) ||
          captchaPattern.test(id) ||
          captchaPattern.test(placeholder)
        ) {
          // Look for a nearby <img> — walk up to the parent form or 3 levels
          let container: Element | null = input.closest('form') ?? input.parentElement;
          for (let i = 0; i < 3 && container && !container.querySelector('img'); i++) {
            container = container.parentElement;
          }
          if (container?.querySelector('img')) return true;
        }

        // Check associated <label>
        const labelFor = input.id
          ? document.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`)
          : null;
        if (labelFor && captchaPattern.test(labelFor.textContent ?? '')) {
          let container: Element | null = input.closest('form') ?? input.parentElement;
          for (let i = 0; i < 3 && container && !container.querySelector('img'); i++) {
            container = container.parentElement;
          }
          if (container?.querySelector('img')) return true;
        }
      }

      return false;
    });

    if (!found) return null;
    return { detected: true, type: 'image-captcha' };
  }

  // -----------------------------------------------------------------------
  // Solving
  // -----------------------------------------------------------------------

  /**
   * Solve a previously-detected CAPTCHA and inject the answer into the page.
   */
  async solve(page: Page, detection: CaptchaDetection): Promise<CaptchaSolveResult> {
    if (!detection.detected || !detection.type) {
      return { solved: false, error: 'No CAPTCHA detected' };
    }

    try {
      switch (detection.type) {
        case 'recaptcha-v2':
          return await this.solveRecaptchaV2(page, detection);
        case 'recaptcha-v3':
          return await this.solveRecaptchaV3(page, detection);
        case 'hcaptcha':
          return await this.solveHCaptcha(page, detection);
        case 'cloudflare-turnstile':
          return await this.solveTurnstile(page, detection);
        case 'image-captcha':
          return await this.solveImageCaptcha(page);
        default:
          return { solved: false, error: `Unsupported CAPTCHA type: ${detection.type}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { solved: false, error: msg };
    }
  }

  private async solveRecaptchaV2(
    page: Page,
    detection: CaptchaDetection,
  ): Promise<CaptchaSolveResult> {
    const siteKey = detection.siteKey;
    if (!siteKey) return { solved: false, error: 'Missing reCAPTCHA v2 sitekey' };

    const result = await this.solver.recaptcha({
      googlekey: siteKey,
      pageurl: page.url(),
    });

    await this.injectRecaptchaToken(page, result.data);
    return { solved: true };
  }

  private async solveRecaptchaV3(
    page: Page,
    detection: CaptchaDetection,
  ): Promise<CaptchaSolveResult> {
    const siteKey = detection.siteKey;
    if (!siteKey) return { solved: false, error: 'Missing reCAPTCHA v3 sitekey' };

    const result = await this.solver.recaptcha({
      googlekey: siteKey,
      pageurl: page.url(),
      version: 'v3',
      min_score: 0.7,
    });

    await this.injectRecaptchaToken(page, result.data);
    return { solved: true };
  }

  private async injectRecaptchaToken(page: Page, token: string): Promise<void> {
    await page.evaluate((t: string) => {
      // Fill the response textarea(s)
      const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[name="g-recaptcha-response"]',
      ));
      for (const ta of textareas) {
        ta.value = t;
        ta.style.display = 'block';
      }

      // Attempt to invoke callback if registered
      const w = window as unknown as Record<string, unknown>;
      if (typeof w.___grecaptcha_cfg === 'object' && w.___grecaptcha_cfg) {
        const cfg = w.___grecaptcha_cfg as Record<string, Record<string, unknown>>;
        for (const key of Object.keys(cfg)) {
          const entry = cfg[key];
          if (entry && typeof entry.callback === 'function') {
            (entry.callback as (token: string) => void)(t);
          }
        }
      }
    }, token);
  }

  private async solveHCaptcha(
    page: Page,
    detection: CaptchaDetection,
  ): Promise<CaptchaSolveResult> {
    const siteKey = detection.siteKey;
    if (!siteKey) return { solved: false, error: 'Missing hCaptcha sitekey' };

    const result = await this.solver.hcaptcha({
      sitekey: siteKey,
      pageurl: page.url(),
    });

    await page.evaluate((t: string) => {
      // Fill hCaptcha response textareas
      const textareas = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
        'textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]',
      ));
      for (const ta of textareas) {
        ta.value = t;
      }

      // Try hcaptcha callback
      const w = window as unknown as Record<string, unknown>;
      if (
        typeof w.hcaptcha === 'object' &&
        w.hcaptcha &&
        typeof (w.hcaptcha as Record<string, unknown>).getRespKey === 'function'
      ) {
        // hCaptcha stores callbacks internally; set the response
        const setResp = (w.hcaptcha as Record<string, (r: string) => void>).setResponse;
        if (typeof setResp === 'function') setResp(t);
      }
    }, result.data);

    return { solved: true };
  }

  private async solveTurnstile(
    page: Page,
    detection: CaptchaDetection,
  ): Promise<CaptchaSolveResult> {
    const siteKey = detection.siteKey;
    if (!siteKey) return { solved: false, error: 'Missing Turnstile sitekey' };

    const result = await this.solver.cloudflareTurnstile({
      sitekey: siteKey,
      pageurl: page.url(),
    });

    await page.evaluate((t: string) => {
      // Turnstile typically stores its token in a hidden input
      const inputs = Array.from(document.querySelectorAll<HTMLInputElement>(
        'input[name="cf-turnstile-response"]',
      ));
      for (const inp of inputs) {
        inp.value = t;
      }

      // Attempt callback via turnstile global
      const w = window as unknown as Record<string, unknown>;
      if (
        typeof w.turnstile === 'object' &&
        w.turnstile &&
        typeof (w.turnstile as Record<string, unknown>).getResponse === 'function'
      ) {
        // Best-effort: some sites read from a callback
      }
    }, result.data);

    return { solved: true };
  }

  private async solveImageCaptcha(page: Page): Promise<CaptchaSolveResult> {
    // Find the captcha image and take a screenshot of it
    const imgBase64 = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const captchaPattern = /captcha/i;

      for (const input of inputs) {
        const name = input.getAttribute('name') ?? '';
        const id = input.getAttribute('id') ?? '';
        const placeholder = input.getAttribute('placeholder') ?? '';

        if (
          captchaPattern.test(name) ||
          captchaPattern.test(id) ||
          captchaPattern.test(placeholder)
        ) {
          let container: Element | null = input.closest('form') ?? input.parentElement;
          for (let i = 0; i < 3 && container && !container.querySelector('img'); i++) {
            container = container.parentElement;
          }
          const img = container?.querySelector('img');
          if (img) {
            // Draw image to canvas and return as base64
            const canvas = document.createElement('canvas');
            canvas.width = img.naturalWidth || img.width;
            canvas.height = img.naturalHeight || img.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(img, 0, 0);
              return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
            }
          }
        }
      }

      return null;
    });

    if (!imgBase64) {
      return { solved: false, error: 'Could not extract CAPTCHA image' };
    }

    const result = await this.solver.imageCaptcha({ body: imgBase64 });

    // Type the solution into the captcha input
    await page.evaluate((answer: string) => {
      const inputs = Array.from(document.querySelectorAll('input'));
      const captchaPattern = /captcha/i;

      for (const input of inputs) {
        const name = input.getAttribute('name') ?? '';
        const id = input.getAttribute('id') ?? '';
        const placeholder = input.getAttribute('placeholder') ?? '';

        if (
          captchaPattern.test(name) ||
          captchaPattern.test(id) ||
          captchaPattern.test(placeholder)
        ) {
          input.value = answer;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          break;
        }
      }
    }, result.data);

    return { solved: true };
  }

  // -----------------------------------------------------------------------
  // Convenience
  // -----------------------------------------------------------------------

  /**
   * Detect a CAPTCHA on the page and solve it if found.
   * Returns the detection plus the solve result (if applicable).
   */
  async detectAndSolve(
    page: Page,
  ): Promise<{ detection: CaptchaDetection; result: CaptchaSolveResult }> {
    const detection = await this.detect(page);

    if (!detection.detected) {
      return { detection, result: { solved: false } };
    }

    const result = await this.solve(page, detection);
    return { detection, result };
  }
}
