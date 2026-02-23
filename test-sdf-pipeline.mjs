#!/usr/bin/env node
/**
 * Ground-up test of the SDF text pipeline — no browser, no Three.js, no Canvas.
 * Tests each layer independently with synthetic data.
 *
 * Layer 1: EDT (edt1d, edt2d, computeSDF) — pure math
 * Layer 2: FontAtlas normalization — does SDF→[0,1] mapping produce correct values?
 * Layer 3: Atlas UV coordinate math — do UV rects correctly address glyph cells?
 * Layer 4: Shader math simulation — given atlas UVs + quad UVs, does smoothstep
 *          produce expected alpha?
 */
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

// ============================================================
// Copy of edt.ts (pure math, no TS needed)
// ============================================================

const INF = 1e20;

function edt1d(f, d, v, z, n) {
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;
  let k = 0;
  for (let q = 1; q < n; q++) {
    let s;
    do {
      const r = v[k];
      s = (f[q] - f[r] + q * q - r * r) / (2 * q - 2 * r);
      if (s > z[k]) break;
      k--;
    } while (k >= 0);
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    d[q] = dx * dx + f[v[k]];
  }
}

function edt2d(grid, width, height) {
  const maxDim = Math.max(width, height);
  const f = new Float64Array(maxDim);
  const d = new Float64Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float64Array(maxDim + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) f[y] = grid[y * width + x];
    edt1d(f, d, v, z, height);
    for (let y = 0; y < height; y++) grid[y * width + x] = d[y];
  }
  for (let y = 0; y < height; y++) {
    const offset = y * width;
    for (let x = 0; x < width; x++) f[x] = grid[offset + x];
    edt1d(f, d, v, z, width);
    for (let x = 0; x < width; x++) grid[offset + x] = d[x];
  }
}

function computeSDF(imageData, width, height, alphaThreshold = 128) {
  const size = width * height;
  const outside = new Float64Array(size);
  const inside = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    const a = imageData[i * 4 + 3];
    if (a >= alphaThreshold) {
      outside[i] = 0;
      inside[i] = INF;
    } else {
      outside[i] = INF;
      inside[i] = 0;
    }
  }
  edt2d(outside, width, height);
  edt2d(inside, width, height);
  const sdf = new Float64Array(size);
  for (let i = 0; i < size; i++) {
    sdf[i] = Math.sqrt(outside[i]) - Math.sqrt(inside[i]);
  }
  return sdf;
}

// ============================================================
// Copy of FontAtlas normalization constants + math
// ============================================================

const GLYPH_SIZE = 64;
const SDF_SIZE = 32;
const MAX_DISTANCE = 8;

function normalizeSdfValue(dist) {
  const normalized = 0.5 - dist / (2 * MAX_DISTANCE);
  return Math.max(0, Math.min(1, normalized));
}

// ============================================================
// Shader math simulation
// ============================================================

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function shaderAlpha(sdfValue) {
  const edge = 0.5;
  const edgeWidth = 0.1;
  return smoothstep(edge - edgeWidth, edge + edgeWidth, sdfValue);
}

// ============================================================
// Tests
// ============================================================

describe('Layer 1: EDT', () => {
  describe('edt1d', () => {
    it('single point at center', () => {
      const n = 7;
      const f = new Float64Array(n); f.fill(INF);
      const d = new Float64Array(n);
      const v = new Int32Array(n);
      const z = new Float64Array(n + 1);
      f[3] = 0;
      edt1d(f, d, v, z, n);
      // Squared distances from position 3
      const expected = [9, 4, 1, 0, 1, 4, 9];
      for (let i = 0; i < n; i++) {
        assert.ok(Math.abs(d[i] - expected[i]) < 0.001, `d[${i}]: got ${d[i]}, expected ${expected[i]}`);
      }
    });

    it('two points', () => {
      const n = 8;
      const f = new Float64Array(n); f.fill(INF);
      const d = new Float64Array(n);
      const v = new Int32Array(n);
      const z = new Float64Array(n + 1);
      f[1] = 0; f[5] = 0;
      edt1d(f, d, v, z, n);
      const expected = [1, 0, 1, 4, 1, 0, 1, 4];
      for (let i = 0; i < n; i++) {
        assert.ok(Math.abs(d[i] - expected[i]) < 0.001, `d[${i}]: got ${d[i]}, expected ${expected[i]}`);
      }
    });

    it('all background (no points)', () => {
      const n = 4;
      const f = new Float64Array(n); f.fill(INF);
      const d = new Float64Array(n);
      const v = new Int32Array(n);
      const z = new Float64Array(n + 1);
      edt1d(f, d, v, z, n);
      for (let i = 0; i < n; i++) {
        assert.ok(d[i] >= INF * 0.9, `all-bg d[${i}] should be ~INF, got ${d[i]}`);
      }
    });
  });

  describe('edt2d', () => {
    it('single point at center of 5x5', () => {
      const w = 5, h = 5;
      const grid = new Float64Array(w * h); grid.fill(INF);
      grid[2 * w + 2] = 0;
      edt2d(grid, w, h);

      assert.ok(Math.abs(grid[2 * w + 2]) < 0.001, 'center = 0');
      assert.ok(Math.abs(grid[1 * w + 2] - 1) < 0.001, 'adjacent = 1');
      assert.ok(Math.abs(grid[1 * w + 1] - 2) < 0.001, 'diagonal = 2');
      assert.ok(Math.abs(grid[0 * w + 0] - 8) < 0.001, 'corner = 8');
    });
  });

  describe('computeSDF', () => {
    it('filled square produces negative inside, positive outside', () => {
      // 10x10 image, 6x6 filled square at rows 2-7, cols 2-7
      const w = 10, h = 10;
      const img = new Uint8ClampedArray(w * h * 4);
      for (let y = 2; y < 8; y++) {
        for (let x = 2; x < 8; x++) {
          img[(y * w + x) * 4 + 3] = 255;
        }
      }
      const sdf = computeSDF(img, w, h);

      // Center (5,5): inside → negative
      assert.ok(sdf[5 * w + 5] < 0, `center should be negative, got ${sdf[5 * w + 5]}`);
      // Corner (0,0): outside → positive
      assert.ok(sdf[0 * w + 0] > 0, `corner should be positive, got ${sdf[0 * w + 0]}`);
      // Just outside (1,2): positive, distance ~1
      assert.ok(sdf[1 * w + 2] > 0, 'just outside is positive');
      assert.ok(Math.abs(sdf[1 * w + 2] - 1.0) < 0.001, `just outside distance ≈ 1, got ${sdf[1 * w + 2]}`);
    });

    it('empty image produces all positive (outside)', () => {
      const w = 4, h = 4;
      const img = new Uint8ClampedArray(w * h * 4); // all zeros
      const sdf = computeSDF(img, w, h);
      for (let i = 0; i < w * h; i++) {
        // outside - inside: sqrt(INF) - sqrt(0) → should be huge positive
        assert.ok(sdf[i] > 0, `empty image pixel ${i} should be positive`);
      }
    });

    it('fully filled image produces all negative (inside)', () => {
      const w = 4, h = 4;
      const img = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) img[i * 4 + 3] = 255;
      const sdf = computeSDF(img, w, h);
      for (let i = 0; i < w * h; i++) {
        assert.ok(sdf[i] < 0, `fully filled pixel ${i} should be negative`);
      }
    });

    it('boundary pixel has distance ~0', () => {
      // Single pixel "glyph" at (3,3) in 7x7. The pixel itself is "inside".
      // SDF at that pixel: outside dist = 0 (it IS on the boundary), inside dist = 0
      // Actually: single pixel → outside[3,3]=0, inside[3,3]=INF
      // After EDT: outside stays 0, inside stays INF... no, EDT of inside:
      // inside is INF everywhere except where alpha < threshold.
      // For single pixel: inside[3,3] = INF (it's opaque), all others = 0.
      // EDT of inside: at (3,3), nearest 0-cell is adjacent → dist² = 1 → dist = 1
      // SDF = sqrt(outside) - sqrt(inside) = 0 - 1 = -1
      // So a 1-pixel glyph has SDF = -1 at its center. That's correct:
      // it's 1 texel inside the boundary.
      const w = 7, h = 7;
      const img = new Uint8ClampedArray(w * h * 4);
      img[(3 * w + 3) * 4 + 3] = 255;
      const sdf = computeSDF(img, w, h);
      assert.ok(sdf[3 * w + 3] < 0, 'single pixel is inside');
      assert.ok(Math.abs(sdf[3 * w + 3] - (-1)) < 0.001,
        `single pixel SDF ≈ -1, got ${sdf[3 * w + 3]}`);
    });
  });
});

describe('Layer 2: SDF normalization', () => {
  it('boundary (dist=0) maps to 0.5', () => {
    assert.ok(Math.abs(normalizeSdfValue(0) - 0.5) < 0.001,
      `boundary should be 0.5, got ${normalizeSdfValue(0)}`);
  });

  it('inside (negative dist) maps to > 0.5', () => {
    const val = normalizeSdfValue(-4);
    assert.ok(val > 0.5, `inside should be > 0.5, got ${val}`);
    assert.ok(val <= 1.0, `inside should be ≤ 1.0, got ${val}`);
  });

  it('outside (positive dist) maps to < 0.5', () => {
    const val = normalizeSdfValue(4);
    assert.ok(val < 0.5, `outside should be < 0.5, got ${val}`);
    assert.ok(val >= 0.0, `outside should be ≥ 0.0, got ${val}`);
  });

  it('MAX_DISTANCE outside maps to 0.0', () => {
    assert.ok(Math.abs(normalizeSdfValue(MAX_DISTANCE) - 0.0) < 0.001,
      `max outside distance should map to 0`);
  });

  it('-MAX_DISTANCE inside maps to 1.0', () => {
    assert.ok(Math.abs(normalizeSdfValue(-MAX_DISTANCE) - 1.0) < 0.001,
      `max inside distance should map to 1`);
  });

  it('clamps beyond range', () => {
    assert.equal(normalizeSdfValue(100), 0.0, 'far outside clamps to 0');
    assert.equal(normalizeSdfValue(-100), 1.0, 'far inside clamps to 1');
  });
});

describe('Layer 3: Atlas UV coordinate math', () => {
  const ATLAS_SIZE = 512;
  const sdfSize = SDF_SIZE;
  const cols = Math.floor(ATLAS_SIZE / sdfSize);

  function getGlyphUV(slot) {
    const col = slot % cols;
    const row = Math.floor(slot / cols);
    return {
      u: (col * sdfSize) / ATLAS_SIZE,
      v: (row * sdfSize) / ATLAS_SIZE,
      w: sdfSize / ATLAS_SIZE,
      h: sdfSize / ATLAS_SIZE,
    };
  }

  it('slot 0 starts at (0, 0)', () => {
    const uv = getGlyphUV(0);
    assert.equal(uv.u, 0);
    assert.equal(uv.v, 0);
  });

  it('glyph width/height is SDF_SIZE/ATLAS_SIZE', () => {
    const uv = getGlyphUV(0);
    assert.ok(Math.abs(uv.w - 32 / 512) < 0.0001, `w = ${uv.w}`);
    assert.ok(Math.abs(uv.h - 32 / 512) < 0.0001, `h = ${uv.h}`);
  });

  it('slot 1 is adjacent horizontally', () => {
    const uv = getGlyphUV(1);
    assert.ok(Math.abs(uv.u - sdfSize / ATLAS_SIZE) < 0.0001);
    assert.equal(uv.v, 0);
  });

  it('slot at end of first row wraps to second row', () => {
    const uv = getGlyphUV(cols); // first slot of row 1
    assert.equal(uv.u, 0);
    assert.ok(Math.abs(uv.v - sdfSize / ATLAS_SIZE) < 0.0001);
  });

  it('UVs tile exactly — no overlap, no gaps', () => {
    for (let s = 0; s < cols * 2; s++) {
      const uv = getGlyphUV(s);
      // Right edge = u + w should equal next slot's u (or wrap)
      const rightEdge = uv.u + uv.w;
      assert.ok(rightEdge <= 1.0001, `slot ${s} right edge ${rightEdge} <= 1`);
      const bottomEdge = uv.v + uv.h;
      assert.ok(bottomEdge <= 1.0001, `slot ${s} bottom edge ${bottomEdge} <= 1`);
    }
  });
});

describe('Layer 4: Shader math simulation', () => {
  it('smoothstep at edges', () => {
    assert.ok(Math.abs(smoothstep(0, 1, 0)) < 0.001, 'smoothstep(0,1,0) = 0');
    assert.ok(Math.abs(smoothstep(0, 1, 1) - 1) < 0.001, 'smoothstep(0,1,1) = 1');
    assert.ok(Math.abs(smoothstep(0, 1, 0.5) - 0.5) < 0.001, 'smoothstep(0,1,0.5) = 0.5');
  });

  it('SDF=0.5 (boundary) gives alpha ≈ 0.5', () => {
    const a = shaderAlpha(0.5);
    assert.ok(Math.abs(a - 0.5) < 0.001, `boundary alpha should be ~0.5, got ${a}`);
  });

  it('SDF > 0.6 (inside glyph) gives alpha ≈ 1', () => {
    const a = shaderAlpha(0.8);
    assert.ok(a > 0.99, `deep inside alpha should be ~1, got ${a}`);
  });

  it('SDF < 0.4 (outside glyph) gives alpha ≈ 0', () => {
    const a = shaderAlpha(0.2);
    assert.ok(a < 0.01, `outside alpha should be ~0, got ${a}`);
  });

  it('SDF=0.0 (far outside / empty atlas) gives alpha = 0', () => {
    const a = shaderAlpha(0.0);
    assert.ok(a < 0.001, `empty atlas sample should give alpha 0, got ${a}`);
  });

  describe('full pipeline: synthetic glyph → normalized SDF → shader alpha', () => {
    it('center of a filled circle produces opaque alpha', () => {
      // 16x16 filled circle, radius 6, center (8,8)
      const w = 16, h = 16;
      const img = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - 7.5, dy = y - 7.5;
          if (dx * dx + dy * dy <= 36) {
            img[(y * w + x) * 4 + 3] = 255;
          }
        }
      }

      const sdf = computeSDF(img, w, h);

      // Center pixel (8,8): should be well inside
      const centerDist = sdf[8 * w + 8];
      assert.ok(centerDist < 0, `center dist should be negative, got ${centerDist}`);

      const normalized = normalizeSdfValue(centerDist);
      assert.ok(normalized > 0.5, `normalized center should be > 0.5, got ${normalized}`);

      const alpha = shaderAlpha(normalized);
      assert.ok(alpha > 0.99, `center alpha should be ~1, got ${alpha}`);
    });

    it('far outside a filled circle produces transparent alpha', () => {
      const w = 16, h = 16;
      const img = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const dx = x - 7.5, dy = y - 7.5;
          if (dx * dx + dy * dy <= 36) {
            img[(y * w + x) * 4 + 3] = 255;
          }
        }
      }

      const sdf = computeSDF(img, w, h);

      // Corner pixel (0,0): should be well outside
      const cornerDist = sdf[0];
      assert.ok(cornerDist > 0, `corner dist should be positive, got ${cornerDist}`);

      const normalized = normalizeSdfValue(cornerDist);
      assert.ok(normalized < 0.5, `normalized corner should be < 0.5, got ${normalized}`);

      const alpha = shaderAlpha(normalized);
      assert.ok(alpha < 0.01, `corner alpha should be ~0, got ${alpha}`);
    });

    it('blank glyph (zero UV rect) produces alpha=0 via isBlank check', () => {
      // Simulating shader: if aGlyphUV.z == 0, alpha = 0
      const glyphUV_z = 0; // width = 0 → blank
      const isBlank = glyphUV_z === 0;
      const alpha = isBlank ? 0 : shaderAlpha(0.5);
      assert.equal(alpha, 0, 'blank glyph alpha = 0');
    });
  });
});

describe('Layer 4b: Atlas sampling simulation', () => {
  it('quad UV (0,0) maps to glyph top-left in atlas', () => {
    // Glyph at slot 3: u=3*32/512, v=0, w=32/512, h=32/512
    const glyph = { u: 3 * 32 / 512, v: 0, w: 32 / 512, h: 32 / 512 };
    const quadX = 0, quadY = 0;
    const atlasU = glyph.u + quadX * glyph.w;
    const atlasV = glyph.v + quadY * glyph.h;
    assert.ok(Math.abs(atlasU - glyph.u) < 0.0001, 'quad (0,0) → glyph left edge');
    assert.ok(Math.abs(atlasV - glyph.v) < 0.0001, 'quad (0,0) → glyph top edge');
  });

  it('quad UV (1,1) maps to glyph bottom-right in atlas', () => {
    const glyph = { u: 3 * 32 / 512, v: 0, w: 32 / 512, h: 32 / 512 };
    const quadX = 1, quadY = 1;
    const atlasU = glyph.u + quadX * glyph.w;
    const atlasV = glyph.v + quadY * glyph.h;
    assert.ok(Math.abs(atlasU - (glyph.u + glyph.w)) < 0.0001);
    assert.ok(Math.abs(atlasV - (glyph.v + glyph.h)) < 0.0001);
  });

  it('quad UV (0.5, 0.5) maps to glyph center in atlas', () => {
    const glyph = { u: 2 * 32 / 512, v: 1 * 32 / 512, w: 32 / 512, h: 32 / 512 };
    const quadX = 0.5, quadY = 0.5;
    const atlasU = glyph.u + quadX * glyph.w;
    const atlasV = glyph.v + quadY * glyph.h;
    const expectedU = (2 * 32 + 16) / 512;
    const expectedV = (1 * 32 + 16) / 512;
    assert.ok(Math.abs(atlasU - expectedU) < 0.0001);
    assert.ok(Math.abs(atlasV - expectedV) < 0.0001);
  });

  it('sampling from a zeroed atlas returns 0.0 → alpha ≈ 0', () => {
    // If the atlas is all zeros (Float32Array default), sampling gives 0.0
    // That's the SDF value directly — 0.0 means "far outside"
    const sampledSdf = 0.0;
    const alpha = shaderAlpha(sampledSdf);
    assert.ok(alpha < 0.001, `zeroed atlas should give alpha ~0, got ${alpha}`);
  });
});

describe('Edge case: what happens when ALL instances sample slot 0?', () => {
  it('if atlas has a glyph at slot 0, sampling (0,0) with nonzero UV shows that glyph', () => {
    // This is the suspected bug scenario: if attribute binding is broken,
    // all instances read glyphUV = (0,0,0,0) from stale/zeroed buffer.
    // isBlank check catches this: z=0 → alpha=0.
    const staleGlyphUV = { x: 0, y: 0, z: 0, w: 0 };
    const isBlank = staleGlyphUV.z === 0;
    assert.ok(isBlank, 'zero UV rect triggers isBlank');
    // BUT: if the buffer isn't zero but has garbage/stale data with z>0,
    // the isBlank check won't save us. That's a different failure mode.
  });

  it('if attribute binding is broken and buffer has stale nonzero data, glyph renders', () => {
    // Simulating: buffer was written once with glyph data for slot 0,
    // but subsequent sync() writes go to a disconnected buffer.
    // The shader keeps reading the original values.
    const staleGlyphUV = { x: 0, y: 0, z: 32 / 512, w: 32 / 512 };
    const isBlank = staleGlyphUV.z === 0;
    assert.ok(!isBlank, 'nonzero stale data is NOT caught by isBlank check');
    // This means: every instance renders slot 0's glyph. Matches the screenshot.
  });
});
