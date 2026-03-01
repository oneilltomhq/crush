/**
 * TextTexture — renders scrollable text content (e.g. markdown todo lists)
 * onto a Canvas2D, exposed as a THREE.CanvasTexture for pane surfaces.
 *
 * Architecture:
 *   - Full content is rendered once onto a tall offscreen canvas.
 *   - A fixed-size viewport canvas (matching pane aspect) is exposed as the texture.
 *   - scrollY controls which slice of the full canvas is visible.
 *   - Scroll via scroll() / scrollTo(); the scene wires mouse-wheel.
 */

import * as THREE from 'three/webgpu';

export interface TextTextureOptions {
  content: string;
  title?: string;
  /** Viewport width  (default 640) */
  width?: number;
  /** Viewport height (default 384) */
  height?: number;
}

// ── Colours ──────────────────────────────────────────────────────────
const BG           = '#0d1117';
const TITLE_BAR_BG = '#161b22';
const TITLE_FG     = '#c9d1d9';
const TEXT_FG      = '#c9d1d9';
const HEADER_FG    = '#58a6ff';
const CHECK_ON     = '#3fb950';
const CHECK_OFF    = '#6e7681';
const BULLET_FG    = '#6e7681';
const HR_COLOR     = '#30363d';
const SCROLLBAR_BG = 'rgba(255,255,255,0.05)';
const SCROLLBAR_FG = 'rgba(255,255,255,0.15)';

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
const SCROLLBAR_W  = 4;

export class TextTexture {
  readonly texture: THREE.CanvasTexture;

  /** The viewport canvas (fixed size, used as texture source). */
  readonly canvas: HTMLCanvasElement;
  private vpCtx: CanvasRenderingContext2D;
  private vpW: number;
  private vpH: number;

  /** The full-content offscreen canvas. */
  private fullCanvas: HTMLCanvasElement;
  private fullCtx: CanvasRenderingContext2D;
  private fullH = 0;        // total content height

  private title: string;
  private content: string;
  private _scrollY = 0;     // pixels scrolled from top
  private _titleH = 0;      // title bar height (drawn on viewport, not scrolled)

  /** Maximum scrollY value. */
  get maxScroll(): number { return Math.max(0, this.fullH - this.scrollableH); }

  /** Height of the scrollable region (viewport minus title bar). */
  private get scrollableH(): number { return this.vpH - this._titleH; }

  get scrollY(): number { return this._scrollY; }

  constructor(options: TextTextureOptions) {
    this.vpW = options.width || 640;
    this.vpH = options.height || 384;
    this.title = options.title || '';
    this.content = options.content;
    this._titleH = this.title ? TITLE_BAR_H : 0;

    // Viewport canvas (texture source)
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.vpW;
    this.canvas.height = this.vpH;
    this.vpCtx = this.canvas.getContext('2d')!;

    // Full content canvas (offscreen, tall)
    this.fullCanvas = document.createElement('canvas');
    this.fullCanvas.width = this.vpW;
    this.fullCanvas.height = 1; // resized by renderFull()
    this.fullCtx = this.fullCanvas.getContext('2d')!;

    this.renderFull();
    this.blit();

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
  }

  // ── Public API ────────────────────────────────────────────────────

  updateContent(content: string, autoScrollToBottom = false): void {
    this.content = content;
    this.renderFull();
    if (autoScrollToBottom) {
      this._scrollY = this.maxScroll;
    } else {
      this._scrollY = Math.min(this._scrollY, this.maxScroll);
    }
    this.blit();
    this.texture.needsUpdate = true;
  }

  /** Scroll by delta pixels. Positive = down. */
  scroll(dy: number): void {
    const prev = this._scrollY;
    this._scrollY = Math.max(0, Math.min(this.maxScroll, this._scrollY + dy));
    if (this._scrollY !== prev) {
      this.blit();
      this.texture.needsUpdate = true;
    }
  }

  scrollTo(y: number): void {
    this.scroll(y - this._scrollY);
  }

  update(_time: number): void { /* static */ }

  dispose(): void {
    this.texture.dispose();
  }

  // ── Full content render (offscreen) ───────────────────────────────

  private renderFull(): void {
    const w = this.vpW;
    const ctx = this.fullCtx;

    // Measure
    // We need a context for measureText — use a temp 1px canvas
    ctx.font = `${FONT_BODY}px monospace`;
    const blocks = this.measureContent(ctx, w);

    let totalH = PAD_Y;
    for (const b of blocks) totalH += b.gapBefore + b.totalH + b.gapAfter;
    totalH += PAD_Y;

    // Resize full canvas
    this.fullCanvas.height = totalH;
    this.fullH = totalH;
    this.fullCtx = this.fullCanvas.getContext('2d')!;
    const dc = this.fullCtx;

    // Background
    dc.fillStyle = BG;
    dc.fillRect(0, 0, w, totalH);

    dc.textAlign = 'left';
    dc.textBaseline = 'top';
    let y = PAD_Y;

    for (const b of blocks) {
      y += b.gapBefore;
      switch (b.type) {
        case 'header':
          dc.fillStyle = HEADER_FG;
          dc.font = `bold ${b.fontSize}px monospace`;
          for (const line of b.wrappedLines) { dc.fillText(line, PAD_X, y); y += b.lineH; }
          break;
        case 'todo-on':
          dc.font = `${FONT_BODY}px monospace`;
          dc.fillStyle = CHECK_ON;
          dc.fillText('\u2611', PAD_X, y);
          dc.fillStyle = '#484f58';
          for (const line of b.wrappedLines) { dc.fillText(line, b.indent, y); y += b.lineH; }
          break;
        case 'todo-off':
          dc.font = `${FONT_BODY}px monospace`;
          dc.fillStyle = CHECK_OFF;
          dc.fillText('\u2610', PAD_X, y);
          dc.fillStyle = TEXT_FG;
          for (const line of b.wrappedLines) { dc.fillText(line, b.indent, y); y += b.lineH; }
          break;
        case 'bullet':
          dc.font = `${FONT_BODY}px monospace`;
          dc.fillStyle = BULLET_FG;
          dc.fillText('\u2022', PAD_X, y);
          dc.fillStyle = TEXT_FG;
          for (const line of b.wrappedLines) { dc.fillText(line, b.indent, y); y += b.lineH; }
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
          for (const line of b.wrappedLines) { dc.fillText(line, PAD_X, y); y += b.lineH; }
          break;
      }
      y += b.gapAfter;
    }
  }

  // ── Blit visible window to viewport canvas ────────────────────────

  private blit(): void {
    const dc = this.vpCtx;
    const w = this.vpW;
    const h = this.vpH;
    const titleH = this._titleH;
    const contentH = h - titleH;

    // Clear
    dc.fillStyle = BG;
    dc.fillRect(0, 0, w, h);

    // Title bar (fixed, not scrolled)
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
    }

    // Blit scrolled content region
    if (this.fullH > 0) {
      dc.drawImage(
        this.fullCanvas,
        0, this._scrollY, w, contentH,   // source rect
        0, titleH, w, contentH,           // dest rect
      );
    }

    // Scrollbar (only if content overflows)
    if (this.fullH > contentH) {
      const trackX = w - SCROLLBAR_W - 2;
      const trackH = contentH - 4;
      const trackY = titleH + 2;

      // Track
      dc.fillStyle = SCROLLBAR_BG;
      dc.fillRect(trackX, trackY, SCROLLBAR_W, trackH);

      // Thumb
      const thumbRatio = contentH / this.fullH;
      const thumbH = Math.max(12, trackH * thumbRatio);
      const scrollRatio = this.maxScroll > 0 ? this._scrollY / this.maxScroll : 0;
      const thumbY = trackY + scrollRatio * (trackH - thumbH);

      dc.fillStyle = SCROLLBAR_FG;
      dc.beginPath();
      dc.roundRect(trackX, thumbY, SCROLLBAR_W, thumbH, 2);
      dc.fill();
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
        blocks.push({ type: 'header', text, fontSize, lineH, indent: PAD_X,
          wrappedLines: wrapped, totalH: wrapped.length * lineH, gapBefore: 4, gapAfter: 2 });
      } else if (todoChecked) {
        const text = todoChecked[2];
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        const indent = PAD_X + ctx.measureText('\u2611 ').width;
        const wrapped = this.wrapText(text, w - indent - PAD_X, ctx);
        blocks.push({ type: 'todo-on', text, fontSize: FONT_BODY, lineH, indent,
          wrappedLines: wrapped, totalH: wrapped.length * lineH, gapBefore: 0, gapAfter: 0 });
      } else if (todoUnchecked) {
        const text = todoUnchecked[2];
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        const indent = PAD_X + ctx.measureText('\u2610 ').width;
        const wrapped = this.wrapText(text, w - indent - PAD_X, ctx);
        blocks.push({ type: 'todo-off', text, fontSize: FONT_BODY, lineH, indent,
          wrappedLines: wrapped, totalH: wrapped.length * lineH, gapBefore: 0, gapAfter: 0 });
      } else if (hrMatch) {
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        blocks.push({ type: 'hr', text: '', fontSize: FONT_BODY, lineH, indent: 0,
          wrappedLines: [], totalH: lineH, gapBefore: 4, gapAfter: 4 });
      } else if (bulletMatch && !todoUnchecked && !todoChecked) {
        const text = bulletMatch[2];
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        const indent = PAD_X + ctx.measureText('\u2022 ').width;
        const wrapped = this.wrapText(text, w - indent - PAD_X, ctx);
        blocks.push({ type: 'bullet', text, fontSize: FONT_BODY, lineH, indent,
          wrappedLines: wrapped, totalH: wrapped.length * lineH, gapBefore: 0, gapAfter: 0 });
      } else if (raw.trim() === '') {
        const halfH = Math.round(FONT_BODY * LINE_HEIGHT * 0.5);
        blocks.push({ type: 'blank', text: '', fontSize: FONT_BODY, lineH: halfH, indent: 0,
          wrappedLines: [], totalH: halfH, gapBefore: 0, gapAfter: 0 });
      } else {
        const lineH = Math.round(FONT_BODY * LINE_HEIGHT);
        ctx.font = `${FONT_BODY}px monospace`;
        const wrapped = this.wrapText(raw, w - PAD_X * 2, ctx);
        blocks.push({ type: 'text', text: raw, fontSize: FONT_BODY, lineH, indent: PAD_X,
          wrappedLines: wrapped, totalH: wrapped.length * lineH, gapBefore: 0, gapAfter: 0 });
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

interface LayoutLine {
  type: 'header' | 'todo-on' | 'todo-off' | 'bullet' | 'blank' | 'text' | 'hr';
  text: string;
  fontSize: number;
  lineH: number;
  indent: number;
  wrappedLines: string[];
  totalH: number;
  gapBefore: number;
  gapAfter: number;
}
