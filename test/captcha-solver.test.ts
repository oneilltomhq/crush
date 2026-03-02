import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  CaptchaSolver,
  type CaptchaDetection,
  type CaptchaType,
} from '../server/captcha-solver';

// ---------------------------------------------------------------------------
// Helpers: fake Page objects
// ---------------------------------------------------------------------------

/**
 * Build a minimal fake Page whose `.evaluate()` returns scripted values and
 * whose `.url()` returns a fixed string. We don't import patchright at all —
 * the solver only uses `page.evaluate(fn, ...args)` and `page.url()`.
 */
function fakePage(
  evaluateResults: unknown[],
  url = 'https://example.com',
) {
  let callIndex = 0;
  return {
    url: () => url,
    evaluate: vi.fn(async () => {
      const result = evaluateResults[callIndex];
      callIndex++;
      return result;
    }),
    $: vi.fn(async () => null),
  };
}

// ---------------------------------------------------------------------------
// Stub out the 2captcha Solver so no real HTTP calls are made.
// We monkey-patch the prototype before each test.
// ---------------------------------------------------------------------------

const solverStubs = {
  recaptcha: vi.fn(),
  hcaptcha: vi.fn(),
  cloudflareTurnstile: vi.fn(),
  imageCaptcha: vi.fn(),
};

vi.mock('2captcha-ts', () => ({
  Solver: class FakeSolver {
    constructor(public apikey: string) {}
    recaptcha = solverStubs.recaptcha;
    hcaptcha = solverStubs.hcaptcha;
    cloudflareTurnstile = solverStubs.cloudflareTurnstile;
    imageCaptcha = solverStubs.imageCaptcha;
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CaptchaSolver', () => {
  let solver: CaptchaSolver;

  beforeEach(() => {
    solver = new CaptchaSolver('TEST_API_KEY');
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // detect()
  // -----------------------------------------------------------------------

  describe('detect()', () => {
    it('detects reCAPTCHA v2 when .g-recaptcha is present', async () => {
      // evaluate calls in order: recaptchaV2, recaptchaV3, hcaptcha, turnstile, imageCaptcha
      // First call (recaptchaV2) returns a sitekey — rest are never called.
      const page = fakePage(['SITE_KEY_V2']);
      const result = await solver.detect(page as any);

      expect(result).toEqual({
        detected: true,
        type: 'recaptcha-v2',
        siteKey: 'SITE_KEY_V2',
      });
    });

    it('detects reCAPTCHA v2 with empty sitekey (element present but no data attr)', async () => {
      const page = fakePage(['']);
      const result = await solver.detect(page as any);

      expect(result).toEqual({
        detected: true,
        type: 'recaptcha-v2',
        siteKey: undefined,
      });
    });

    it('detects reCAPTCHA v3 when grecaptcha.execute is in scripts', async () => {
      // First call (recaptchaV2) returns null, second call (recaptchaV3) returns found
      const page = fakePage([
        null, // no v2
        { found: true, siteKey: 'V3_KEY' },
      ]);
      const result = await solver.detect(page as any);

      expect(result).toEqual({
        detected: true,
        type: 'recaptcha-v3',
        siteKey: 'V3_KEY',
      });
    });

    it('detects hCaptcha when .h-captcha is present', async () => {
      const page = fakePage([
        null, // no v2
        { found: false, siteKey: '' }, // no v3
        'HCAPTCHA_KEY', // hcaptcha found
      ]);
      const result = await solver.detect(page as any);

      expect(result).toEqual({
        detected: true,
        type: 'hcaptcha',
        siteKey: 'HCAPTCHA_KEY',
      });
    });

    it('detects Cloudflare Turnstile', async () => {
      const page = fakePage([
        null, // no v2
        { found: false, siteKey: '' }, // no v3
        null, // no hcaptcha
        'TURNSTILE_KEY', // turnstile found
      ]);
      const result = await solver.detect(page as any);

      expect(result).toEqual({
        detected: true,
        type: 'cloudflare-turnstile',
        siteKey: 'TURNSTILE_KEY',
      });
    });

    it('detects generic image CAPTCHA', async () => {
      const page = fakePage([
        null, // no v2
        { found: false, siteKey: '' }, // no v3
        null, // no hcaptcha
        null, // no turnstile
        true, // image captcha found
      ]);
      const result = await solver.detect(page as any);

      expect(result).toEqual({
        detected: true,
        type: 'image-captcha',
      });
    });

    it('returns detected:false when no CAPTCHA is present', async () => {
      const page = fakePage([
        null, // no v2
        { found: false, siteKey: '' }, // no v3
        null, // no hcaptcha
        null, // no turnstile
        false, // no image captcha
      ]);
      const result = await solver.detect(page as any);

      expect(result).toEqual({ detected: false, type: null });
    });
  });

  // -----------------------------------------------------------------------
  // solve()
  // -----------------------------------------------------------------------

  describe('solve()', () => {
    it('calls solver.recaptcha for reCAPTCHA v2 and injects token', async () => {
      solverStubs.recaptcha.mockResolvedValue({ data: 'TOKEN_V2', id: '123' });

      const page = fakePage([], 'https://example.com/page');
      const detection: CaptchaDetection = {
        detected: true,
        type: 'recaptcha-v2',
        siteKey: 'SITE_KEY',
      };

      const result = await solver.solve(page as any, detection);

      expect(result).toEqual({ solved: true });
      expect(solverStubs.recaptcha).toHaveBeenCalledWith({
        googlekey: 'SITE_KEY',
        pageurl: 'https://example.com/page',
      });
      // evaluate is called once to inject the token
      expect(page.evaluate).toHaveBeenCalled();
    });

    it('calls solver.recaptcha with v3 params for reCAPTCHA v3', async () => {
      solverStubs.recaptcha.mockResolvedValue({ data: 'TOKEN_V3', id: '456' });

      const page = fakePage([], 'https://example.com/v3');
      const detection: CaptchaDetection = {
        detected: true,
        type: 'recaptcha-v3',
        siteKey: 'V3_KEY',
      };

      const result = await solver.solve(page as any, detection);

      expect(result).toEqual({ solved: true });
      expect(solverStubs.recaptcha).toHaveBeenCalledWith({
        googlekey: 'V3_KEY',
        pageurl: 'https://example.com/v3',
        version: 'v3',
        min_score: 0.7,
      });
    });

    it('calls solver.hcaptcha for hCaptcha and injects token', async () => {
      solverStubs.hcaptcha.mockResolvedValue({ data: 'HTOKEN', id: '789' });

      const page = fakePage([], 'https://example.com/hc');
      const detection: CaptchaDetection = {
        detected: true,
        type: 'hcaptcha',
        siteKey: 'HC_KEY',
      };

      const result = await solver.solve(page as any, detection);

      expect(result).toEqual({ solved: true });
      expect(solverStubs.hcaptcha).toHaveBeenCalledWith({
        sitekey: 'HC_KEY',
        pageurl: 'https://example.com/hc',
      });
    });

    it('calls solver.cloudflareTurnstile for Turnstile', async () => {
      solverStubs.cloudflareTurnstile.mockResolvedValue({ data: 'CF_TOKEN', id: 'abc' });

      const page = fakePage([], 'https://example.com/cf');
      const detection: CaptchaDetection = {
        detected: true,
        type: 'cloudflare-turnstile',
        siteKey: 'CF_KEY',
      };

      const result = await solver.solve(page as any, detection);

      expect(result).toEqual({ solved: true });
      expect(solverStubs.cloudflareTurnstile).toHaveBeenCalledWith({
        sitekey: 'CF_KEY',
        pageurl: 'https://example.com/cf',
      });
    });

    it('calls solver.imageCaptcha with base64 body for image captchas', async () => {
      solverStubs.imageCaptcha.mockResolvedValue({ data: 'XY12Z', id: 'img1' });

      // First evaluate extracts the image base64, second injects the answer
      const page = fakePage(['BASE64_IMAGE_DATA', undefined]);
      const detection: CaptchaDetection = {
        detected: true,
        type: 'image-captcha',
      };

      const result = await solver.solve(page as any, detection);

      expect(result).toEqual({ solved: true });
      expect(solverStubs.imageCaptcha).toHaveBeenCalledWith({
        body: 'BASE64_IMAGE_DATA',
      });
    });

    it('returns error when no CAPTCHA detected', async () => {
      const page = fakePage([]);
      const result = await solver.solve(page as any, {
        detected: false,
        type: null,
      });

      expect(result).toEqual({ solved: false, error: 'No CAPTCHA detected' });
    });

    it('returns error when sitekey is missing for reCAPTCHA v2', async () => {
      const page = fakePage([]);
      const result = await solver.solve(page as any, {
        detected: true,
        type: 'recaptcha-v2',
        // no siteKey
      });

      expect(result).toEqual({ solved: false, error: 'Missing reCAPTCHA v2 sitekey' });
    });

    it('returns error when sitekey is missing for hCaptcha', async () => {
      const page = fakePage([]);
      const result = await solver.solve(page as any, {
        detected: true,
        type: 'hcaptcha',
      });

      expect(result).toEqual({ solved: false, error: 'Missing hCaptcha sitekey' });
    });

    it('returns error when sitekey is missing for Turnstile', async () => {
      const page = fakePage([]);
      const result = await solver.solve(page as any, {
        detected: true,
        type: 'cloudflare-turnstile',
      });

      expect(result).toEqual({ solved: false, error: 'Missing Turnstile sitekey' });
    });

    it('returns error when image extraction fails', async () => {
      const page = fakePage([null]); // evaluate returns null (no image found)
      const result = await solver.solve(page as any, {
        detected: true,
        type: 'image-captcha',
      });

      expect(result).toEqual({ solved: false, error: 'Could not extract CAPTCHA image' });
    });

    it('catches 2captcha API errors and returns them', async () => {
      solverStubs.recaptcha.mockRejectedValue(new Error('ERROR_CAPTCHA_UNSOLVABLE'));

      const page = fakePage([], 'https://example.com');
      const result = await solver.solve(page as any, {
        detected: true,
        type: 'recaptcha-v2',
        siteKey: 'KEY',
      });

      expect(result).toEqual({
        solved: false,
        error: 'ERROR_CAPTCHA_UNSOLVABLE',
      });
    });
  });

  // -----------------------------------------------------------------------
  // detectAndSolve()
  // -----------------------------------------------------------------------

  describe('detectAndSolve()', () => {
    it('detects and solves a reCAPTCHA v2 in one call', async () => {
      solverStubs.recaptcha.mockResolvedValue({ data: 'SOLVED', id: '1' });

      // detect() evaluate calls: recaptchaV2 returns siteKey
      // solve()  evaluate calls: inject token
      const page = fakePage(['MY_SITE_KEY', undefined], 'https://example.com');

      const { detection, result } = await solver.detectAndSolve(page as any);

      expect(detection).toEqual({
        detected: true,
        type: 'recaptcha-v2',
        siteKey: 'MY_SITE_KEY',
      });
      expect(result).toEqual({ solved: true });
      expect(solverStubs.recaptcha).toHaveBeenCalledOnce();
    });

    it('returns not-solved when no CAPTCHA is found', async () => {
      const page = fakePage([
        null, // no v2
        { found: false, siteKey: '' }, // no v3
        null, // no hcaptcha
        null, // no turnstile
        false, // no image
      ]);

      const { detection, result } = await solver.detectAndSolve(page as any);

      expect(detection.detected).toBe(false);
      expect(result.solved).toBe(false);
      // No 2captcha calls should have been made
      expect(solverStubs.recaptcha).not.toHaveBeenCalled();
      expect(solverStubs.hcaptcha).not.toHaveBeenCalled();
      expect(solverStubs.cloudflareTurnstile).not.toHaveBeenCalled();
      expect(solverStubs.imageCaptcha).not.toHaveBeenCalled();
    });

    it('propagates solve errors through detectAndSolve', async () => {
      solverStubs.hcaptcha.mockRejectedValue(new Error('TIMEOUT'));

      const page = fakePage([
        null, // no v2
        { found: false, siteKey: '' }, // no v3
        'HC_KEY', // hcaptcha detected
        // solve injects nothing since it errors
      ], 'https://example.com/hc');

      const { detection, result } = await solver.detectAndSolve(page as any);

      expect(detection.type).toBe('hcaptcha');
      expect(result).toEqual({ solved: false, error: 'TIMEOUT' });
    });
  });
});
