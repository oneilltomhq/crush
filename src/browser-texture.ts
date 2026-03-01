/**
 * BrowserTexture — a live browser tab rendered as a THREE.CanvasTexture.
 *
 * Connects to the CDP relay WebSocket, receives JPEG screencast frames,
 * decodes them onto a canvas, and exposes the result as a texture for
 * use on a 3D pane.
 *
 * Also supports sending commands back (navigate, click, type) for
 * interactive control of the remote tab.
 */

import * as THREE from 'three/webgpu';

export interface BrowserTextureOptions {
  /** WebSocket URL of the CDP relay server */
  wsUrl: string;
  /** Canvas width (default: 640, matching terminal pane) */
  width?: number;
  /** Canvas height (default: 384, matching terminal pane) */
  height?: number;
}

export class BrowserTexture {
  readonly texture: THREE.CanvasTexture;
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private ws: WebSocket | null = null;
  private disposed = false;
  private frameCount = 0;
  private lastFrameTime = 0;
  private _fps = 0;
  private meta: { tabId?: string; url?: string; width?: number; height?: number } = {};
  private connected = false;

  /** Status text for HUD display */
  get status(): string {
    if (!this.connected) return 'connecting...';
    return `${this.meta.url || 'unknown'} (${this._fps} fps)`;
  }

  get fps(): number { return this._fps; }
  get tabUrl(): string { return this.meta.url || ''; }

  constructor(private options: BrowserTextureOptions) {
    const w = options.width || 640;
    const h = options.height || 384;

    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d')!;

    // Dark placeholder
    this.ctx.fillStyle = '#0a0a1a';
    this.ctx.fillRect(0, 0, w, h);
    this.ctx.fillStyle = '#334';
    this.ctx.font = '14px monospace';
    this.ctx.textAlign = 'center';
    this.ctx.fillText('connecting to browser...', w / 2, h / 2);

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;

    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;

    this.ws = new WebSocket(this.options.wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[BrowserTexture] Connected to relay');
      this.connected = true;
    };

    this.ws.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // Metadata message
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'meta') {
            this.meta = msg;
            console.log(`[BrowserTexture] Tab: ${msg.url} (${msg.width}x${msg.height})`);
          }
        } catch (e) {
          // ignore parse errors
        }
      } else {
        // Binary = JPEG frame
        this.decodeFrame(event.data as ArrayBuffer);
      }
    };

    this.ws.onclose = () => {
      console.log('[BrowserTexture] Disconnected');
      this.connected = false;
      // Reconnect after 2s
      if (!this.disposed) {
        setTimeout(() => this.connect(), 2000);
      }
    };

    this.ws.onerror = (e) => {
      console.error('[BrowserTexture] WS error:', e);
    };
  }

  private decodeFrame(data: ArrayBuffer): void {
    const blob = new Blob([data], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      if (this.disposed) {
        URL.revokeObjectURL(url);
        return;
      }
      // Draw scaled to fit our canvas
      this.ctx.drawImage(img, 0, 0, this.canvas.width, this.canvas.height);
      this.texture.needsUpdate = true;
      URL.revokeObjectURL(url);

      // FPS tracking
      this.frameCount++;
      const now = performance.now();
      if (now - this.lastFrameTime >= 1000) {
        this._fps = this.frameCount;
        this.frameCount = 0;
        this.lastFrameTime = now;
      }
    };
    img.src = url;
  }

  /** Send a navigate command to the remote tab */
  navigate(url: string): void {
    this.sendCommand({ type: 'navigate', url });
  }

  /** Send a click at (x, y) in tab viewport coordinates */
  click(x: number, y: number): void {
    this.sendCommand({ type: 'click', x, y });
  }

  /** Type text into the remote tab */
  type(text: string): void {
    this.sendCommand({ type: 'type', text });
  }

  /** Send a key event */
  keydown(key: string, code: string, modifiers = 0): void {
    this.sendCommand({ type: 'keydown', key, code, modifiers });
  }

  private sendCommand(cmd: any): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(cmd));
    }
  }

  /** No-op update for API compatibility with TerminalTexture */
  update(_time: number): void {
    // Texture updates happen asynchronously in decodeFrame.
    // This method exists so grid-scene can call update() uniformly.
  }

  dispose(): void {
    this.disposed = true;
    this.ws?.close();
    this.texture.dispose();
  }
}
