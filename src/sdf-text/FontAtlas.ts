import * as THREE from 'three/webgpu';
import { computeSDF } from './edt';

const GLYPH_SIZE = 64; // render resolution per glyph
const SDF_SIZE = 32;   // SDF output resolution per glyph (downsampled)
const SDF_PADDING = 4; // extra texels of distance field around glyph
const MAX_DISTANCE = 8; // max encoded distance in texels

export interface GlyphMetrics {
  u: number;  // atlas UV left
  v: number;  // atlas UV top
  w: number;  // atlas UV width
  h: number;  // atlas UV height
}

export class FontAtlas {
  readonly cellSize = SDF_SIZE;
  private canvas: OffscreenCanvas;
  private ctx: OffscreenCanvasRenderingContext2D;
  private glyphs = new Map<string, GlyphMetrics>();
  private atlasData: Float32Array;
  private cols: number;
  private rows: number;
  private nextSlot = 0;
  texture: THREE.DataTexture;

  constructor(
    private fontFamily = 'monospace',
    private fontSize = GLYPH_SIZE - SDF_PADDING * 2,
    atlasSize = 512,
  ) {
    this.canvas = new OffscreenCanvas(GLYPH_SIZE, GLYPH_SIZE);
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.cols = Math.floor(atlasSize / SDF_SIZE);
    this.rows = this.cols;
    this.atlasData = new Float32Array(atlasSize * atlasSize);

    this.texture = new THREE.DataTexture(
      this.atlasData,
      atlasSize,
      atlasSize,
      THREE.RedFormat,
      THREE.FloatType,
    );
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.needsUpdate = true;
  }

  get atlasSize(): number {
    return this.cols * SDF_SIZE;
  }

  getGlyph(char: string): GlyphMetrics {
    let m = this.glyphs.get(char);
    if (m) return m;
    m = this.rasterizeGlyph(char);
    this.glyphs.set(char, m);
    this.texture.needsUpdate = true;
    return m;
  }

  hasGlyph(char: string): boolean {
    return this.glyphs.has(char);
  }

  ensureGlyphs(chars: Iterable<string>): boolean {
    let added = false;
    for (const ch of chars) {
      if (!this.glyphs.has(ch)) {
        this.getGlyph(ch);
        added = true;
      }
    }
    return added;
  }

  private rasterizeGlyph(char: string): GlyphMetrics {
    const slot = this.nextSlot++;
    const col = slot % this.cols;
    const row = Math.floor(slot / this.cols);
    const atlasW = this.atlasSize;

    // Render glyph to canvas at high res
    const ctx = this.ctx;
    ctx.clearRect(0, 0, GLYPH_SIZE, GLYPH_SIZE);
    ctx.fillStyle = 'white';
    ctx.font = `${this.fontSize}px ${this.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(char, GLYPH_SIZE / 2, GLYPH_SIZE / 2);

    const imgData = ctx.getImageData(0, 0, GLYPH_SIZE, GLYPH_SIZE);

    // Compute SDF at render resolution
    const sdfHiRes = computeSDF(imgData.data, GLYPH_SIZE, GLYPH_SIZE);

    // Downsample to SDF_SIZE
    const scaleX = GLYPH_SIZE / SDF_SIZE;
    const scaleY = GLYPH_SIZE / SDF_SIZE;

    for (let sy = 0; sy < SDF_SIZE; sy++) {
      for (let sx = 0; sx < SDF_SIZE; sx++) {
        // Sample from center of destination texel
        const srcX = Math.min(Math.floor((sx + 0.5) * scaleX), GLYPH_SIZE - 1);
        const srcY = Math.min(Math.floor((sy + 0.5) * scaleY), GLYPH_SIZE - 1);
        const dist = sdfHiRes[srcY * GLYPH_SIZE + srcX];

        // Normalize: map [-MAX_DISTANCE, MAX_DISTANCE] → [0, 1]
        const normalized = 0.5 - dist / (2 * MAX_DISTANCE);
        const clamped = Math.max(0, Math.min(1, normalized));

        const atlasX = col * SDF_SIZE + sx;
        const atlasY = row * SDF_SIZE + sy;
        this.atlasData[atlasY * atlasW + atlasX] = clamped;
      }
    }

    return {
      u: (col * SDF_SIZE) / atlasW,
      v: (row * SDF_SIZE) / atlasW,
      w: SDF_SIZE / atlasW,
      h: SDF_SIZE / atlasW,
    };
  }
}
