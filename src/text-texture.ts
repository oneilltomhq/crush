/**
 * TextTexture — renders static text content (e.g. markdown todo lists)
 * onto a Canvas2D, exposed as a THREE.CanvasTexture for use as a pane surface.
 *
 * Canvas auto-sizes vertically to fit all content (no clipping).
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
const HR_COLOR     = '#30363d';

// ── Font sizes ───────────────────────────────────────────────────────
const FONT_BODY    = 14;
const FONT_H1      = 22;
const FONT_H2      = 18;
const FONT_H3      = 16;
const FONT_TITLE   = 13;
const LINE_HEIGHT  = 1.45;
const TITLE_BAR_H  = 28;
const PAD_X        = 16;
const PAD_Y        = 12;

/** Parsed line with type info and pre-computed metrics. */
interface LayoutLine {
  type: 'header' | 'todo-on' | 'todo-off' | 'bullet' | 'blank' | 'text' | 'hr';
  text: string;
  fontSize: number;
  lineH: number;
  indent: number;       // x offset for text after glyph
  wrappedLines: string[];
  totalH: number;       // total height this block occupies
  gapBefore: number;
  gapAfter: number;
}

export class TextTexture {
  readonly texture: THREE.CanvasTexture;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w: number;
  private title: string;
  private content: string;

  constructor(options: TextTextureOptions) {
    this.w = options.width || 640;
    this.title = options.title || '';
    this.content = options.content;

    this.canvas = document.createElement('canvas');
    this.canvas.width = this.w;
    this.canvas.height = 1;  // will be resized by render()
    this.ctx = this.canvas.getContext('2d')!;

    this.render();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  // ── Public API ────────────────────────────────────────────────────

  updateContent(content: string): void {
    this.content = content;
    this.render();
    this.texture.needsUpdate = true;
  }

  update(_time: number): void { /* static content */ }

  dispose(): void {
    this.texture.dispose();
  }

  // ── Rendering ─────────────────────────────────────────────────────

  private render(): void {
    const ctx = this.ctx;
    const w = this.w;

    // 1) Parse and measure all lines
    const blocks = this.measureContent(ctx, w);

    // 2) Compute total height
    const titleH = this.title ? TITLE_BAR_H + PAD_Y : PAD_Y;
    let totalH = titleH;
    for (const b of blocks) {
      totalH += b.gapBefore + b.totalH + b.gapAfter;
    }
    totalH += PAD_Y; // bottom padding

    // 3) Resize canvas to fit
    this.canvas.height = totalH;
    // getContext after resize (canvas clears)
    this.ctx = this.canvas.getContext('2d')!;
    const dc = this.ctx;

    // 4) Draw background
    dc.fillStyle = BG;
    dc.fillRect(0, 0, w, totalH);

    let y = 0;

    // 5) Title bar
    if (this.title) {
      dc.fillStyle = TITLE_BAR_BG;
      dc.fillRect(0, 0, w, TITLE_BAR_H);

      const dotY = TITLE_BAR_H / 2;
      for (const [i, c] of ['#ff5f57', '#febc2e', '#28c840'].entries()) {
        dc.fillStyle = c;
        dc.beginPath();
        dc.arc(12 + i * 16, dotY, 4, 0, Math.PI * 2);
        dc.fill();
      }

      dc.fillStyle = TITLE_FG;
      dc.font = `${FONT_TITLE}px monospace`;
      dc.textBaseline = 'middle';
      dc.textAlign = 'center';
      dc.fillText(this.title, w / 2, dotY);

      dc.strokeStyle = HR_COLOR;
      dc.lineWidth = 1;
      dc.beginPath();
      dc.moveTo(0, TITLE_BAR_H - 0.5);
      dc.lineTo(w, TITLE_BAR_H - 0.5);
      dc.stroke();

      y = TITLE_BAR_H + PAD_Y;
    } else {
      y = PAD_Y;
    }

    dc.textAlign = 'left';
    dc.textBaseline = 'top';

    // 6) Draw content blocks
    for (const b of blocks) {
      y += b.gapBefore;

      switch (b.type) {
        case 'header':
          dc.fillStyle = HEADER_FG;
          dc.font = `bold ${b.fontSize}px monospace`;
          for (const line of b.wrappedLines) {
            dc.fillText(line, PAD_X, y);
            y += b.lineH;
          }
          break;

        case 'todo-on':
          dc.font = `${FONT_BODY}px monospace`;
          dc.fillStyle = CHECK_ON;
          dc.fillText('☑', PAD_X, y);
          dc.fillStyle = '#484f58';
          for (const line of b.wrappedLines) {
            dc.fillText(line, b.indent, y);
            y += b.lineH;
          }
          break;

        case 'todo-off':
          dc.font = `${FONT_BODY}px monospace`;
          dc.fillStyle = CHECK_OFF;
          dc.fillText('☐', PAD_X, y);
          dc.fillStyle = TEXT_FG;
          for (const line of b.wrappedLines) {
            dc.fillText(line, b.indent, y);
            y += b.lineH;
          }
          break;

        case 'bullet':
          dc.font = `${FONT_BODY}px monospace`;
          dc.fillStyle = BULLET_FG;
          dc.fillText('•', PAD_X, y);
          dc.fillStyle = TEXT_FG;
          for (const line of b.wrappedLines) {
            dc.fillText(line, b.indent, y);
            y += b.lineH;
          }
          break;

        case 'hr':
          dc.strokeStyle = HR_COLOR;
          dc.lineWidth = 1;
          dc.beginPath();
          dc.moveTo(PAD_X, y + b.lineH / 2);
          dc.lineTo(w - PAD_X, y + b.lineH / 2);
          dc.stroke();
          y += b.lineH;
          break;

        case 'blank':
          y += b.totalH;
          break;

        case 'text':
          dc.fillStyle = TEXT_FG;
          dc.font = `${FONT_BODY}px monospace`;
          for (const line of b.wrappedLines) {
            dc.fillText(line, PAD_X, y);
            y += b.lineH;
          }
          break;
      }

      y += b.gapAfter;
    }
  }

  // ── Content measurement ───────────────────────────────────────────

  private measureContent(ctx: CanvasRenderingContext2D, w: number): LayoutLine[] {
    const blocks: LayoutLine[] = [];
    const lines = this.content.split('\n');

    for (const raw of lines) {
      const headerMatch = raw.match(/^(#{1,3})\s+(.*)$/);
      const todoChecked = raw.match(/^(\s*)-\s*\[x\]\s+(.*)$/i);
      const todoUnchecked = raw.match(/^(\s*)-\s*\[ \]\s+(.*)$/);
      const hrMatch = raw.match(/^\s*---+\s*$/);
      const bulletMatch = raw.match(/^(\s*)-\s+(.*)$/);

      if (headerMatch) {
        const level = headerMatch[1].length;
        const text = headerMatch[2];
        const fontSize = level === 1 ? FONT_H1 : level === 2 ? FONT_H2 : FONT_H3;
        const lineH = Math.round(fontSize * LINE_HEIGHT);
        ctx.font = `bold ${fontSize}px monospace`;
        const wrapped = this.wrapText(text, w - PAD_X * 2, ctx);
        blocks.push({
          type: 'header', text, fontSize, lineH, indent: PAD_X,
          wrappedLines: wrapped, totalH: wrapped.length * lineH,
          gapBefore: 4, gapAfter: 2,
        });
      } else if (todoChecked) {
        const text = todoChecked[2];
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        const indent = PAD_X + ctx.measureText('☑ ').width;
        const wrapped = this.wrapText(text, w - indent - PAD_X, ctx);
        blocks.push({
          type: 'todo-on', text, fontSize: FONT_BODY, lineH, indent,
          wrappedLines: wrapped, totalH: wrapped.length * lineH,
          gapBefore: 0, gapAfter: 0,
        });
      } else if (todoUnchecked) {
        const text = todoUnchecked[2];
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        const indent = PAD_X + ctx.measureText('☐ ').width;
        const wrapped = this.wrapText(text, w - indent - PAD_X, ctx);
        blocks.push({
          type: 'todo-off', text, fontSize: FONT_BODY, lineH, indent,
          wrappedLines: wrapped, totalH: wrapped.length * lineH,
          gapBefore: 0, gapAfter: 0,
        });
      } else if (hrMatch) {
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        blocks.push({
          type: 'hr', text: '', fontSize: FONT_BODY, lineH, indent: 0,
          wrappedLines: [], totalH: lineH,
          gapBefore: 4, gapAfter: 4,
        });
      } else if (bulletMatch && !todoUnchecked && !todoChecked) {
        const text = bulletMatch[2];
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        const indent = PAD_X + ctx.measureText('• ').width;
        const wrapped = this.wrapText(text, w - indent - PAD_X, ctx);
        blocks.push({
          type: 'bullet', text, fontSize: FONT_BODY, lineH, indent,
          wrappedLines: wrapped, totalH: wrapped.length * lineH,
          gapBefore: 0, gapAfter: 0,
        });
      } else if (raw.trim() === '') {
        const halfH = Math.round(FONT_BODY * LINE_HEIGHT * 0.5);
        blocks.push({
          type: 'blank', text: '', fontSize: FONT_BODY, lineH: halfH, indent: 0,
          wrappedLines: [], totalH: halfH,
          gapBefore: 0, gapAfter: 0,
        });
      } else {
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        const wrapped = this.wrapText(raw, w - PAD_X * 2, ctx);
        blocks.push({
          type: 'text', text: raw, fontSize: FONT_BODY, lineH, indent: PAD_X,
          wrappedLines: wrapped, totalH: wrapped.length * lineH,
          gapBefore: 0, gapAfter: 0,
        });
      }
    }

    return blocks;
  }

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
