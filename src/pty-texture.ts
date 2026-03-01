/**
 * PtyTexture — a remote PTY session rendered via Ghostty WASM.
 *
 * Connects to a PTY WebSocket relay (server/pty-relay.ts), pipes
 * terminal data through ghostty-web for VT emulation, and renders
 * the result to a Canvas2D texture for Three.js panes.
 *
 * Same rendering pipeline as TerminalTexture, but the byte stream
 * comes from a real shell on the server instead of LocalShell.
 */

import * as THREE from 'three/webgpu';
import type { Ghostty, GhosttyTerminal } from 'ghostty-web';

const COLS = 80;
const ROWS = 24;
const CELL_W = 8;
const CELL_H = 16;
const CANVAS_W = COLS * CELL_W;
const CANVAS_H = ROWS * CELL_H;

const RECONNECT_DELAY = 2000;
const MAX_RECONNECTS = 5;

export class PtyTexture {
  readonly term: GhosttyTerminal;
  readonly texture: THREE.CanvasTexture;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private disposed = false;
  private cursorBlinkPhase = 0;
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private reconnectCount = 0;
  private connected = false;

  constructor(ghostty: Ghostty, wsUrl: string) {
    this.wsUrl = wsUrl;
    this.term = ghostty.createTerminal(COLS, ROWS);

    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d')!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;

    // Show connecting message
    this.showStatus('Connecting...');

    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.binaryType = 'arraybuffer';
    } catch (err) {
      console.error('PTY WebSocket creation failed:', err);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      console.log('PTY connected to', this.wsUrl);
      this.connected = true;
      this.reconnectCount = 0;
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        // Binary: terminal output from PTY
        const bytes = new Uint8Array(ev.data);
        this.term.write(bytes);
      } else if (typeof ev.data === 'string') {
        // Text: JSON control message
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'meta') {
            console.log(`PTY meta: shell=${msg.shell}, pid=${msg.pid}, ${msg.cols}x${msg.rows}`);
          } else if (msg.type === 'exit') {
            console.log(`PTY exited: code=${msg.exitCode}, signal=${msg.signal}`);
            this.showStatus(`Shell exited (${msg.exitCode})`);
          }
        } catch {
          // Plain text data, write to terminal
          this.term.write(ev.data);
        }
      }
    };

    this.ws.onclose = () => {
      console.log('PTY WebSocket closed');
      this.connected = false;
      if (!this.disposed) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      console.error('PTY WebSocket error:', err);
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectCount >= MAX_RECONNECTS) {
      this.showStatus(this.reconnectCount >= MAX_RECONNECTS
        ? 'Connection failed'
        : 'Disconnected');
      return;
    }
    this.reconnectCount++;
    this.showStatus(`Reconnecting (${this.reconnectCount}/${MAX_RECONNECTS})...`);
    setTimeout(() => this.connect(), RECONNECT_DELAY);
  }

  /** Feed raw keyboard input — sent to server PTY. */
  feed(data: string): void {
    if (this.ws && this.connected) {
      // Send as binary (raw terminal input)
      this.ws.send(new TextEncoder().encode(data));
    }
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

  private showStatus(msg: string): void {
    const ctx = this.ctx;
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.font = '14px monospace';
    ctx.fillStyle = '#666';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.fillText(msg, CANVAS_W / 2, CANVAS_H / 2);
    ctx.textAlign = 'left';
    this.texture.needsUpdate = true;
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

      const bgR = cell.bg_r, bgG = cell.bg_g, bgB = cell.bg_b;
      if (bgR > 10 || bgG > 10 || bgB > 10) {
        ctx.fillStyle = `rgb(${bgR},${bgG},${bgB})`;
        ctx.fillRect(x, y, CELL_W, CELL_H);
      }

      const cp = cell.codepoint;
      if (cp > 0x20) {
        ctx.fillStyle = `rgb(${cell.fg_r},${cell.fg_g},${cell.fg_b})`;
        ctx.fillText(String.fromCodePoint(cp), x + 1, y + 1);
      }
    }

    if (cursor.visible && this.cursorBlinkPhase === 0) {
      const cx = cursor.x * CELL_W;
      const cy = cursor.y * CELL_H;
      ctx.fillStyle = 'rgba(200,200,200,0.7)';
      ctx.fillRect(cx, cy, CELL_W, CELL_H);

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
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.texture.dispose();
  }
}
