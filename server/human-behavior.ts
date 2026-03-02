/**
 * human-behavior.ts — Simulate human-like browser interaction patterns.
 *
 * Wraps patchright Page actions with realistic timing, Bézier-curve mouse
 * movement, variable-speed typing, and smooth scrolling to avoid bot detection.
 */

import { type Page, type ElementHandle } from 'patchright';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** All timing ranges are [min, max] in milliseconds unless noted. */
export interface HumanBehaviorConfig {
  /** Base inter-key delay range (ms). */
  typingDelay: [number, number];
  /** Extra pause at word-boundary characters (space, punctuation) (ms). */
  typingWordBoundaryDelay: [number, number];
  /** Mouse movement duration range (ms). */
  mouseMoveDuration: [number, number];
  /** Number of intermediate steps for a mouse move. */
  mouseMoveSteps: [number, number];
  /** Max random pixel offset when clicking inside an element's bounding box. */
  clickOffsetMax: number;
  /** Delay between arriving at target and pressing the mouse button (ms). */
  clickSettleDelay: [number, number];
  /** Probability (0-1) of a "double-check hover" before clicking. */
  clickDoubleCheckProbability: number;
  /** Scroll step size range (px). */
  scrollStepSize: [number, number];
  /** Delay between scroll steps (ms). */
  scrollStepDelay: [number, number];
  /** Probability (0-1) of a micro-pause during scrolling. */
  scrollMicroPauseProbability: number;
  /** Duration of a scroll micro-pause (ms). */
  scrollMicroPauseDuration: [number, number];
  /** Amplitude of random idle micro-movements (px). */
  idleMicroMovementRadius: number;
  /** Interval between idle micro-movements (ms). */
  idleMicroMovementInterval: [number, number];
  /** Jitter applied to Bézier control points as a fraction of the total distance. */
  bezierJitter: number;
}

export const DEFAULT_CONFIG: HumanBehaviorConfig = {
  typingDelay: [50, 150],
  typingWordBoundaryDelay: [200, 400],
  mouseMoveDuration: [300, 700],
  mouseMoveSteps: [20, 40],
  clickOffsetMax: 4,
  clickSettleDelay: [50, 150],
  clickDoubleCheckProbability: 0.12,
  scrollStepSize: [30, 120],
  scrollStepDelay: [15, 60],
  scrollMicroPauseProbability: 0.15,
  scrollMicroPauseDuration: [100, 300],
  idleMicroMovementRadius: 3,
  idleMicroMovementInterval: [400, 1200],
  bezierJitter: 0.25,
};

// ---------------------------------------------------------------------------
// Math utilities (exported for testing)
// ---------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** Return a random number uniformly distributed in [min, max]. */
export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Return a random integer in [min, max] (inclusive). */
export function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

/**
 * Generate points along a cubic Bézier curve from `start` to `end`.
 *
 * Control points are placed roughly at 1/3 and 2/3 of the way along the
 * straight line, then offset by random jitter proportional to the total
 * distance. This produces a smooth, non-linear path.
 *
 * @param start   Starting point.
 * @param end     Ending point.
 * @param steps   Number of intermediate points (excluding start, including end).
 * @param jitter  Max jitter as a fraction of the total distance.
 * @returns       Array of `steps` points along the curve (does NOT include `start`).
 */
export function bezierPath(
  start: Point,
  end: Point,
  steps: number,
  jitter: number,
): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const jitterPx = dist * jitter;

  // Two control points with random perpendicular + parallel offset.
  const cp1: Point = {
    x: start.x + dx / 3 + rand(-jitterPx, jitterPx),
    y: start.y + dy / 3 + rand(-jitterPx, jitterPx),
  };
  const cp2: Point = {
    x: start.x + (2 * dx) / 3 + rand(-jitterPx, jitterPx),
    y: start.y + (2 * dy) / 3 + rand(-jitterPx, jitterPx),
  };

  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    points.push(cubicBezier(start, cp1, cp2, end, t));
  }
  return points;
}

/** Evaluate a cubic Bézier at parameter t ∈ [0, 1]. */
function cubicBezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  const uu = u * u;
  const uuu = uu * u;
  const tt = t * t;
  const ttt = tt * t;
  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

/**
 * Generate an eased delay schedule for mouse movement.
 *
 * Uses an ease-in-out curve so the pointer starts slow, moves fast through
 * the middle, and decelerates near the target — mimicking a real hand.
 *
 * @param totalMs  Total movement duration in milliseconds.
 * @param steps    Number of steps.
 * @returns        Per-step delay array (ms) that sums to ~totalMs.
 */
export function easedDelays(totalMs: number, steps: number): number[] {
  // Use a sine-based ease-in-out: slow at edges, fast in the middle.
  // Weight each step by the *inverse* of the derivative of the ease curve
  // so that more time is spent at the start and end.
  const rawWeights: number[] = [];
  for (let i = 0; i < steps; i++) {
    // Parameter t at the midpoint of this segment.
    const t = (i + 0.5) / steps;
    // ease-in-out sine derivative: π/2 · sin(πt). Invert it for delay weight.
    const speed = Math.sin(Math.PI * t); // 0 at edges, 1 at center
    // Clamp to avoid division by zero at the very edges.
    rawWeights.push(1 / Math.max(speed, 0.15));
  }
  const sum = rawWeights.reduce((a, b) => a + b, 0);
  return rawWeights.map((w) => (w / sum) * totalMs);
}

/**
 * Generate per-character typing delays that mimic a human rhythm.
 *
 * - Base keys: uniform random in `baseRange`.
 * - Word-boundary characters (space, comma, period, etc.): additional pause
 *   drawn from `boundaryRange`.
 *
 * @returns Array of delays in ms, one per character in `text`.
 */
export function typingDelays(
  text: string,
  baseRange: [number, number],
  boundaryRange: [number, number],
): number[] {
  const BOUNDARY = /[\s,.;:!?\-]/;
  return Array.from(text).map((ch) => {
    const base = rand(baseRange[0], baseRange[1]);
    const extra = BOUNDARY.test(ch) ? rand(boundaryRange[0], boundaryRange[1]) : 0;
    return base + extra;
  });
}

/**
 * Generate non-uniform scroll step sizes that sum to approximately `totalPx`.
 *
 * Each step is drawn randomly from `stepRange`, then the sequence is scaled
 * so the sum hits the target.
 */
export function scrollSteps(
  totalPx: number,
  stepRange: [number, number],
): number[] {
  if (totalPx <= 0) return [];
  const avgStep = (stepRange[0] + stepRange[1]) / 2;
  const count = Math.max(1, Math.round(totalPx / avgStep));
  const raw: number[] = [];
  for (let i = 0; i < count; i++) {
    raw.push(rand(stepRange[0], stepRange[1]));
  }
  const sum = raw.reduce((a, b) => a + b, 0);
  const scale = totalPx / sum;
  return raw.map((v) => v * scale);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HumanBehavior class
// ---------------------------------------------------------------------------

export class HumanBehavior {
  private page: Page;
  private cfg: HumanBehaviorConfig;
  /** Last known mouse position (for incremental moves). */
  private cursor: Point = { x: 0, y: 0 };

  constructor(page: Page, config?: Partial<HumanBehaviorConfig>) {
    this.page = page;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  // -----------------------------------------------------------------------
  // moveTo — Bézier-curve mouse movement with eased timing
  // -----------------------------------------------------------------------

  async moveTo(x: number, y: number): Promise<void> {
    const steps = randInt(this.cfg.mouseMoveSteps[0], this.cfg.mouseMoveSteps[1]);
    const duration = rand(this.cfg.mouseMoveDuration[0], this.cfg.mouseMoveDuration[1]);
    const path = bezierPath(this.cursor, { x, y }, steps, this.cfg.bezierJitter);
    const delays = easedDelays(duration, steps);

    for (let i = 0; i < path.length; i++) {
      await this.page.mouse.move(path[i].x, path[i].y);
      await sleep(delays[i]);
    }
    this.cursor = { x, y };
  }

  // -----------------------------------------------------------------------
  // click — Move to element, optional double-check hover, then click
  // -----------------------------------------------------------------------

  async click(selector: string): Promise<void> {
    const el = await this.page.waitForSelector(selector);
    if (!el) throw new Error(`Element not found: ${selector}`);

    const box = await el.boundingBox();
    if (!box) throw new Error(`Element has no bounding box: ${selector}`);

    // Target: center with small random offset.
    const targetX = box.x + box.width / 2 + rand(-this.cfg.clickOffsetMax, this.cfg.clickOffsetMax);
    const targetY = box.y + box.height / 2 + rand(-this.cfg.clickOffsetMax, this.cfg.clickOffsetMax);

    await this.moveTo(targetX, targetY);

    // Occasional "double-check" — move slightly away then back.
    if (Math.random() < this.cfg.clickDoubleCheckProbability) {
      const away = 8 + rand(0, 12);
      await this.moveTo(targetX + rand(-away, away), targetY + rand(-away, away));
      await sleep(rand(80, 200));
      await this.moveTo(targetX, targetY);
    }

    // Small settle delay before clicking.
    await sleep(rand(this.cfg.clickSettleDelay[0], this.cfg.clickSettleDelay[1]));
    await this.page.mouse.click(targetX, targetY);
  }

  // -----------------------------------------------------------------------
  // type — Human-rhythm keystroke entry
  // -----------------------------------------------------------------------

  async type(selector: string, text: string): Promise<void> {
    // Click into the field first.
    await this.click(selector);

    const delays = typingDelays(text, this.cfg.typingDelay, this.cfg.typingWordBoundaryDelay);
    const chars = Array.from(text);

    for (let i = 0; i < chars.length; i++) {
      await this.page.keyboard.type(chars[i]);
      await sleep(delays[i]);
    }
  }

  // -----------------------------------------------------------------------
  // scroll — Smooth non-uniform scrolling with micro-pauses
  // -----------------------------------------------------------------------

  async scroll(direction: 'up' | 'down', amount: number): Promise<void> {
    const sign = direction === 'down' ? 1 : -1;
    const steps = scrollSteps(amount, this.cfg.scrollStepSize);

    for (const step of steps) {
      await this.page.mouse.wheel(0, sign * step);
      await sleep(rand(this.cfg.scrollStepDelay[0], this.cfg.scrollStepDelay[1]));

      // Occasional micro-pause to mimic reading or hesitation.
      if (Math.random() < this.cfg.scrollMicroPauseProbability) {
        await sleep(
          rand(this.cfg.scrollMicroPauseDuration[0], this.cfg.scrollMicroPauseDuration[1]),
        );
      }
    }
  }

  // -----------------------------------------------------------------------
  // idle — Random micro-movements for a given duration
  // -----------------------------------------------------------------------

  async idle(ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const pause = rand(
        this.cfg.idleMicroMovementInterval[0],
        this.cfg.idleMicroMovementInterval[1],
      );
      await sleep(Math.min(pause, end - Date.now()));
      if (Date.now() >= end) break;

      // Tiny random wiggle around current position.
      const r = this.cfg.idleMicroMovementRadius;
      const nx = this.cursor.x + rand(-r, r);
      const ny = this.cursor.y + rand(-r, r);
      await this.page.mouse.move(nx, ny);
      this.cursor = { x: nx, y: ny };
    }
  }
}
