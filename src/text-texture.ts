/**
 * TextTexture — renders static text content (e.g. markdown todo lists)
 * onto a Canvas2D, exposed as a THREE.CanvasTexture for use as a pane surface.
 *
 * Supports basic markdown-like formatting:
 *   - `# Header` lines rendered larger/bolder
 *   - `- [ ]` / `- [x]` rendered as checkbox glyphs
 *   - Plain text with automatic line wrapping
 */

import * as THREE from 'three/webgpu';

export interface TextTextureOptions {
  /** The text content to render */
  content: string;
  /** Optional title shown in a top bar */
  title?: string;
  /** Canvas width  (default 640) */
  width?: number;
  /** Canvas height (default 384) */
  height?: number;
}

// ── Colours ──────────────────────────────────────────────────────────
const BG           = '#0d1117';
const TITLE_BAR_BG = '#161b22';
const TITLE_FG     = '#c9d1d9';
const TEXT_FG      = '#c9d1d9';
const HEADER_FG    = '#58a6ff';
const CHECK_ON     = '#3fb950';   // ☑  green
const CHECK_OFF    = '#6e7681';   // ☐  grey
const BULLET_FG    = '#6e7681';

// ── Font sizes ───────────────────────────────────────────────────────
const FONT_BODY    = 14;
const FONT_H1      = 22;
const FONT_H2      = 18;
const FONT_H3      = 16;
const FONT_TITLE   = 13;
const LINE_HEIGHT  = 1.45;       // multiplied by font size
const TITLE_BAR_H  = 28;
const PAD_X        = 16;
const PAD_Y        = 12;

export class TextTexture {
  readonly texture: THREE.CanvasTexture;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w: number;
  private h: number;
  private title: string;
  private content: string;

  constructor(options: TextTextureOptions) {
    this.w = options.width || 640;
    this.h = options.height || 384;
    this.title = options.title || '';
    this.content = options.content;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = this.h;
    this.ctx = this.canvas.getContext('2d')!;

    this.render();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  // ── Public API ────────────────────────────────────────────────────

  /** Replace the rendered content and refresh the texture. */
  updateContent(content: string): void {
    this.content = content;
    this.render();
    this.texture.needsUpdate = true;
  }

  /** No-op — provided for API compatibility with TerminalTexture / BrowserTexture. */
  update(_time: number): void { /* static content, nothing to do */ }

  dispose(): void {
    this.texture.dispose();
  }

  // ── Rendering ─────────────────────────────────────────────────────

  private render(): void {
    const { ctx, w, h } = this;

    // Background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, w, h);

    let y = 0;

    // Title bar
    if (this.title) {
      ctx.fillStyle = TITLE_BAR_BG;
      ctx.fillRect(0, 0, w, TITLE_BAR_H);

      // Three little dots (decorative window buttons)
      const dotY = TITLE_BAR_H / 2;
      for (const [i, c] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
        ctx.fillStyle = c;
        ctx.beginPath();
        ctx.arc(12 + i * 16, dotY, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = TITLE_FG;
      ctx.font = `${FONT_TITLE}px monospace`;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      ctx.fillText(this.title, w / 2, dotY);

      // Separator
      ctx.strokeStyle = '#30363d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, TITLE_BAR_H - 0.5);
      ctx.lineTo(w, TITLE_BAR_H - 0.5);
      ctx.stroke();

      y = TITLE_BAR_H + PAD_Y;
    } else {
      y = PAD_Y;
    }

    ctx.textAlign = 'left';

    const lines = this.content.split('\n');

    for (const rawLine of lines) {
      if (y > h - PAD_Y) break; // no more room

      const line = rawLine;

      // ── Detect line type ───────────────────────────────────────
      const headerMatch = line.match(/^(#{1,3})\s+(.*)$/);
      const todoUnchecked = line.match(/^(\s*)-\s*\[ \]\s+(.*)$/);
      const todoChecked   = line.match(/^(\s*)-\s*\[x\]\s+(.*)$/i);
      const bulletMatch   = line.match(/^(\s*)-\s+(.*)$/);

      if (headerMatch) {
        const level = headerMatch[1].length; // 1-3
        const text  = headerMatch[2];
        const fontSize = level === 1 ? FONT_H1 : level === 2 ? FONT_H2 : FONT_H3;
        const lineH = Math.round(fontSize * LINE_HEIGHT);

        // Small gap before headers
        y += 4;

        ctx.fillStyle = HEADER_FG;
        ctx.font = `bold ${fontSize}px monospace`;
        ctx.textBaseline = 'top';

        const wrapped = this.wrapText(text, w - PAD_X * 2, ctx);
        for (const wl of wrapped) {
          if (y > h - PAD_Y) break;
          ctx.fillText(wl, PAD_X, y);
          y += lineH;
        }
        y += 2; // small gap after header
      } else if (todoChecked) {
        const text  = todoChecked[2];
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        ctx.textBaseline = 'top';

        // Checkbox glyph
        ctx.fillStyle = CHECK_ON;
        ctx.fillText('☑', PAD_X, y);

        // Strikethrough-style dimmed text
        ctx.fillStyle = '#484f58';
        const indent = PAD_X + ctx.measureText('☑ ').width;
        const wrapped = this.wrapText(text, w - indent - PAD_X, ctx);
        for (const wl of wrapped) {
          if (y > h - PAD_Y) break;
          ctx.fillText(wl, indent, y);
          y += lineH;
        }
      } else if (todoUnchecked) {
        const text  = todoUnchecked[2];
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        ctx.textBaseline = 'top';

        ctx.fillStyle = CHECK_OFF;
        ctx.fillText('☐', PAD_X, y);

        ctx.fillStyle = TEXT_FG;
        const indent = PAD_X + ctx.measureText('☐ ').width;
        const wrapped = this.wrapText(text, w - indent - PAD_X, ctx);
        for (const wl of wrapped) {
          if (y > h - PAD_Y) break;
          ctx.fillText(wl, indent, y);
          y += lineH;
        }
      } else if (bulletMatch && !todoUnchecked && !todoChecked) {
        const text  = bulletMatch[2];
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        ctx.textBaseline = 'top';

        ctx.fillStyle = BULLET_FG;
        ctx.fillText('•', PAD_X, y);

        ctx.fillStyle = TEXT_FG;
        const indent = PAD_X + ctx.measureText('• ').width;
        const wrapped = this.wrapText(text, w - indent - PAD_X, ctx);
        for (const wl of wrapped) {
          if (y > h - PAD_Y) break;
          ctx.fillText(wl, indent, y);
          y += lineH;
        }
      } else if (line.trim() === '') {
        // Blank line — half-height gap
        y += Math.round(FONT_BODY * LINE_HEIGHT * 0.5);
      } else {
        // Plain text
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.fillStyle = TEXT_FG;
        ctx.font = `${FONT_BODY}px monospace`;
        ctx.textBaseline = 'top';

        const wrapped = this.wrapText(line, w - PAD_X * 2, ctx);
        for (const wl of wrapped) {
          if (y > h - PAD_Y) break;
          ctx.fillText(wl, PAD_X, y);
          y += lineH;
        }
      }
    }
  }

  /**
   * Word-wrap `text` to fit within `maxWidth` pixels using the current
   * canvas font. Returns an array of wrapped lines.
   */
  private wrapText(text: string, maxWidth: number, ctx: CanvasRenderingContext2D): string[] {
    if (maxWidth <= 0) return [text];

    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = '';

    for (const word of words) {
      if (!word) continue;
      const test = current ? `${current} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    if (lines.length === 0) lines.push('');
    return lines;
  }
}
