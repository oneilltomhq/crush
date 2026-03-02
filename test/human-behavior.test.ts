/**
 * Tests for human behavior simulation — math and timing only, no browser needed.
 */

import { describe, it, expect } from 'vitest';
import {
  bezierPath,
  easedDelays,
  typingDelays,
  scrollSteps,
  rand,
  type Point,
} from '../server/human-behavior';

describe('bezierPath', () => {
  it('generates the requested number of points', () => {
    const start: Point = { x: 0, y: 0 };
    const end: Point = { x: 100, y: 100 };
    const path = bezierPath(start, end, 20, 0.25);
    expect(path).toHaveLength(20);
  });

  it('ends at the target point', () => {
    const start: Point = { x: 10, y: 20 };
    const end: Point = { x: 500, y: 300 };
    const path = bezierPath(start, end, 30, 0.25);
    const last = path[path.length - 1];
    expect(last.x).toBeCloseTo(end.x, 1);
    expect(last.y).toBeCloseTo(end.y, 1);
  });

  it('produces a non-linear path (points deviate from the straight line)', () => {
    const start: Point = { x: 0, y: 0 };
    const end: Point = { x: 400, y: 0 }; // Horizontal line
    const path = bezierPath(start, end, 50, 0.3);

    // At least some points should have non-zero y (off the straight line).
    const offLine = path.filter((p) => Math.abs(p.y) > 1);
    expect(offLine.length).toBeGreaterThan(0);
  });

  it('with zero jitter produces points close to the straight line', () => {
    const start: Point = { x: 0, y: 0 };
    const end: Point = { x: 100, y: 0 };
    const path = bezierPath(start, end, 20, 0);

    // All points should be very close to y=0
    for (const p of path) {
      expect(Math.abs(p.y)).toBeLessThan(0.1);
    }
  });

  it('handles zero-distance move gracefully', () => {
    const p: Point = { x: 50, y: 50 };
    const path = bezierPath(p, p, 10, 0.25);
    expect(path).toHaveLength(10);
    // All points should be near the start/end
    for (const pt of path) {
      expect(pt.x).toBeCloseTo(50, 0);
      expect(pt.y).toBeCloseTo(50, 0);
    }
  });
});

describe('easedDelays', () => {
  it('produces delays that sum to approximately the total', () => {
    const delays = easedDelays(500, 20);
    expect(delays).toHaveLength(20);
    const sum = delays.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(500, -1); // within ~10ms
  });

  it('has slower edges and faster middle (ease-in-out)', () => {
    const delays = easedDelays(1000, 40);
    // Average of first 5 delays should be higher than average of middle 5
    const edgeAvg = delays.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
    const midAvg = delays.slice(17, 22).reduce((a, b) => a + b, 0) / 5;
    expect(edgeAvg).toBeGreaterThan(midAvg);
  });

  it('all delays are positive', () => {
    const delays = easedDelays(300, 15);
    for (const d of delays) {
      expect(d).toBeGreaterThan(0);
    }
  });
});

describe('typingDelays', () => {
  it('produces one delay per character', () => {
    const text = 'hello world';
    const delays = typingDelays(text, [50, 150], [200, 400]);
    expect(delays).toHaveLength(text.length);
  });

  it('all delays fall within expected ranges', () => {
    const text = 'hello, world!';
    const base: [number, number] = [50, 150];
    const boundary: [number, number] = [200, 400];
    const delays = typingDelays(text, base, boundary);

    for (let i = 0; i < text.length; i++) {
      expect(delays[i]).toBeGreaterThanOrEqual(base[0]);
      // Max possible = base max + boundary max
      expect(delays[i]).toBeLessThanOrEqual(base[1] + boundary[1]);
    }
  });

  it('word-boundary characters have longer average delay', () => {
    // Generate many samples to reduce randomness
    const text = 'aa bb cc dd ee ff gg hh ii jj kk ll mm';
    const delays = typingDelays(text, [50, 150], [200, 400]);

    const letterDelays: number[] = [];
    const spaceDelays: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === ' ') spaceDelays.push(delays[i]);
      else letterDelays.push(delays[i]);
    }

    const letterAvg = letterDelays.reduce((a, b) => a + b, 0) / letterDelays.length;
    const spaceAvg = spaceDelays.reduce((a, b) => a + b, 0) / spaceDelays.length;
    expect(spaceAvg).toBeGreaterThan(letterAvg);
  });

  it('delays are not perfectly uniform', () => {
    const text = 'abcdefghijklmnop';
    const delays = typingDelays(text, [50, 150], [200, 400]);
    // Check that not all delays are the same
    const unique = new Set(delays.map((d) => Math.round(d)));
    expect(unique.size).toBeGreaterThan(1);
  });
});

describe('scrollSteps', () => {
  it('step sizes sum to approximately the requested total', () => {
    const steps = scrollSteps(500, [30, 120]);
    const sum = steps.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(500, -1);
  });

  it('produces non-uniform step sizes', () => {
    const steps = scrollSteps(1000, [30, 120]);
    expect(steps.length).toBeGreaterThan(1);
    const unique = new Set(steps.map((s) => Math.round(s)));
    expect(unique.size).toBeGreaterThan(1);
  });

  it('handles zero amount', () => {
    const steps = scrollSteps(0, [30, 120]);
    expect(steps).toHaveLength(0);
  });

  it('all steps are positive', () => {
    const steps = scrollSteps(300, [30, 120]);
    for (const s of steps) {
      expect(s).toBeGreaterThan(0);
    }
  });
});

describe('rand', () => {
  it('stays within bounds', () => {
    for (let i = 0; i < 100; i++) {
      const v = rand(10, 20);
      expect(v).toBeGreaterThanOrEqual(10);
      expect(v).toBeLessThanOrEqual(20);
    }
  });
});
