/**
 * TerminalTexture — a Ghostty terminal that renders to a Canvas2D,
 * exposed as a THREE.CanvasTexture for use as a pane surface.
 *
 * Each instance owns its own Ghostty terminal, offscreen canvas,
 * and update loop. The texture auto-updates when the terminal is dirty.
 */

import * as THREE from 'three/webgpu';
import type { Ghostty, GhosttyTerminal, KeyEncoder } from 'ghostty-web';

const COLS = 80;
const ROWS = 24;
const CELL_W = 8;   // px per cell
const CELL_H = 16;  // px per cell
const CANVAS_W = COLS * CELL_W;   // 640
const CANVAS_H = ROWS * CELL_H;   // 384

export class TerminalTexture {
  readonly term: GhosttyTerminal;
  readonly texture: THREE.CanvasTexture;
  readonly canvas: HTMLCanvasElement;
  readonly encoder: KeyEncoder;
  private ctx: CanvasRenderingContext2D;
  private disposed = false;

  // Cursor state
  private cursorVisible = true;
  private cursorBlinkPhase = 0;

  constructor(ghostty: Ghostty) {
    this.term = ghostty.createTerminal(COLS, ROWS);
    this.encoder = ghostty.createKeyEncoder();

    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d')!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;

    // Initial render
    this.renderToCanvas();
  }

  /** Write data to the terminal (e.g. shell output). */
  write(data: string): void {
    this.term.write(data);
  }

  /** Call every frame to update the texture if the terminal is dirty. */
  update(time: number): void {
    if (this.disposed) return;

    const dirty = this.term.update();
    const blinkPhase = Math.floor(time / 530) % 2;
    const blinkChanged = blinkPhase !== this.cursorBlinkPhase;
    this.cursorBlinkPhase = blinkPhase;

    if (dirty !== 0 || blinkChanged) {
      this.renderToCanvas();
      this.texture.needsUpdate = true;
    }
  }

  private renderToCanvas(): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    const cells = this.term.getViewport();
    const cursor = this.term.getCursor();

    ctx.font = `${CELL_H - 2}px monospace`;
    ctx.textBaseline = 'top';

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const row = Math.floor(i / COLS);
      const col = i % COLS;
      const x = col * CELL_W;
      const y = row * CELL_H;

      // Background (if not default black)
      const bgR = cell.bg_r, bgG = cell.bg_g, bgB = cell.bg_b;
      if (bgR > 10 || bgG > 10 || bgB > 10) {
        ctx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
        ctx.fillRect(x, y, CELL_W, CELL_H);
      }

      // Glyph
      const cp = cell.codepoint;
      if (cp > 0x20) {
        ctx.fillStyle = `rgb(${cell.fg_r},${cell.fg_g},${cell.fg_b})`;
        ctx.fillText(String.fromCodePoint(cp), x + 1, y + 1);
      }
    }

    // Cursor
    if (cursor.visible && this.cursorBlinkPhase === 0) {
      const cx = cursor.x * CELL_W;
      const cy = cursor.y * CELL_H;
      ctx.fillStyle = 'rgba(200,200,200,0.7)';
      ctx.fillRect(cx, cy, CELL_W, CELL_H);

      // Re-draw the glyph under cursor in inverse
      const cursorIdx = cursor.y * COLS + cursor.x;
      if (cursorIdx < cells.length) {
        const cc = cells[cursorIdx];
        if (cc.codepoint > 0x20) {
          ctx.fillStyle = '#0a0a0f';
          ctx.fillText(String.fromCodePoint(cc.codepoint), cx + 1, cy + 1);
        }
      }
    }

    this.term.markClean();
  }

  dispose(): void {
    this.disposed = true;
    this.texture.dispose();
  }
}
