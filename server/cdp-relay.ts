/**
 * CDP Screencast Relay
 *
 * Connects to a Chrome instance via CDP, opens (or attaches to) a tab,
 * starts Page.startScreencast, and relays JPEG frames to WebSocket clients.
 *
 * Usage:
 *   npx tsx server/cdp-relay.ts [--port 8090] [--url https://example.com]
 *
 * WebSocket protocol (server → client):
 *   Binary message = raw JPEG frame data
 *   Text message   = JSON metadata: { type: 'meta', width, height, tabId, url }
 *
 * WebSocket protocol (client → server):
 *   Text message = JSON command:
 *     { type: 'navigate', url: string }
 *     { type: 'click', x: number, y: number }
 *     { type: 'type', text: string }
 *     { type: 'keydown', key: string, code: string, modifiers?: number }
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

// --- Config ---
const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');
const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '8090');
const TARGET_URL = process.argv.find((_, i, a) => a[i - 1] === '--url') || 'https://example.com';

interface CDPResponse {
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

interface CDPEvent {
  method: string;
  params: any;
}

class CDPConnection {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private eventHandlers = new Map<string, (params: any) => void>();

  async connect(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString());
        if ('id' in msg) {
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message));
            else p.resolve(msg.result);
          }
        } else if ('method' in msg) {
          const handler = this.eventHandlers.get(msg.method);
          if (handler) handler(msg.params);
        }
      });
    });
  }

  async send(method: string, params: any = {}): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws!.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method: string, handler: (params: any) => void): void {
    this.eventHandlers.set(method, handler);
  }

  close(): void {
    this.ws?.close();
  }
}

async function getTabWsUrl(tabUrl?: string): Promise<{ wsUrl: string; tabId: string; pageUrl: string }> {
  // First check existing tabs
  const listRes = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const tabs: any[] = await listRes.json();
  
  // Look for an existing non-extension, non-devtools page
  const existing = tabs.find(t => 
    t.type === 'page' && 
    !t.url.startsWith('chrome://') && 
    !t.url.startsWith('chrome-extension://') &&
    !t.url.startsWith('devtools://')
  );
  
  if (existing) {
    console.log(`Attaching to existing tab: ${existing.url}`);
    return { wsUrl: existing.webSocketDebuggerUrl, tabId: existing.id, pageUrl: existing.url };
  }

  // Create a new tab
  const url = tabUrl || TARGET_URL;
  const newRes = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/new?${encodeURIComponent(url)}`);
  const newTab = await newRes.json();
  console.log(`Created new tab: ${url}`);
  return { wsUrl: newTab.webSocketDebuggerUrl, tabId: newTab.id, pageUrl: url };
}

async function main() {
  console.log(`CDP Relay starting — Chrome at ${CDP_HOST}:${CDP_PORT}, WS on port ${WS_PORT}`);

  const { wsUrl, tabId, pageUrl } = await getTabWsUrl();
  console.log(`Tab ${tabId}: ${pageUrl}`);
  console.log(`CDP WebSocket: ${wsUrl}`);

  const cdp = new CDPConnection();
  await cdp.connect(wsUrl);
  console.log('Connected to CDP');

  await cdp.send('Page.enable');
  
  // Navigate if we got an existing tab and a URL was specified
  if (TARGET_URL !== 'https://example.com') {
    await cdp.send('Page.navigate', { url: TARGET_URL });
    console.log(`Navigated to ${TARGET_URL}`);
  }

  // Track connected WS clients
  const clients = new Set<WebSocket>();
  let screencastRunning = false;
  let lastFrameWidth = 0;
  let lastFrameHeight = 0;

  // Handle screencast frames from CDP
  cdp.on('Page.screencastFrame', async (params) => {
    const { data, metadata, sessionId } = params;
    lastFrameWidth = metadata.deviceWidth || 1280;
    lastFrameHeight = metadata.deviceHeight || 720;

    // Ack the frame so CDP keeps sending
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});

    // Relay to all connected clients as binary
    const buf = Buffer.from(data, 'base64');
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(buf);
      }
    }
  });

  async function startScreencast() {
    if (screencastRunning) return;
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      maxWidth: 1280,
      maxHeight: 720,
      everyNthFrame: 1,
    });
    screencastRunning = true;
    console.log('Screencast started');
  }

  async function stopScreencast() {
    if (!screencastRunning) return;
    await cdp.send('Page.stopScreencast').catch(() => {});
    screencastRunning = false;
    console.log('Screencast stopped');
  }

  // Handle client commands (navigate, click, type)
  async function handleClientCommand(msg: string) {
    try {
      const cmd = JSON.parse(msg);
      switch (cmd.type) {
        case 'navigate':
          await cdp.send('Page.navigate', { url: cmd.url });
          console.log(`Navigate: ${cmd.url}`);
          break;
        case 'click':
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x: cmd.x, y: cmd.y, button: 'left', clickCount: 1
          });
          await cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: cmd.x, y: cmd.y, button: 'left', clickCount: 1
          });
          console.log(`Click: ${cmd.x},${cmd.y}`);
          break;
        case 'type':
          await cdp.send('Input.insertText', { text: cmd.text });
          console.log(`Type: ${cmd.text.substring(0, 20)}...`);
          break;
        case 'keydown': {
          const modifiers = cmd.modifiers || 0;
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyDown', key: cmd.key, code: cmd.code, windowsVirtualKeyCode: cmd.keyCode || 0, modifiers
          });
          await cdp.send('Input.dispatchKeyEvent', {
            type: 'keyUp', key: cmd.key, code: cmd.code, windowsVirtualKeyCode: cmd.keyCode || 0, modifiers
          });
          break;
        }
      }
    } catch (e: any) {
      console.error('Command error:', e.message);
    }
  }

  // WebSocket server
  const wss = new WebSocketServer({ port: WS_PORT });
  wss.on('connection', (ws) => {
    console.log('Client connected');
    clients.add(ws);

    // Send metadata
    ws.send(JSON.stringify({
      type: 'meta',
      width: lastFrameWidth || 1280,
      height: lastFrameHeight || 720,
      tabId,
      url: pageUrl,
    }));

    // Start screencast if first client
    if (clients.size === 1) startScreencast();

    ws.on('message', (data) => {
      if (typeof data === 'string' || data instanceof Buffer) {
        handleClientCommand(data.toString());
      }
    });

    ws.on('close', () => {
      console.log('Client disconnected');
      clients.delete(ws);
      if (clients.size === 0) stopScreencast();
    });
  });

  console.log(`WebSocket relay listening on ws://localhost:${WS_PORT}`);
  console.log(`Waiting for clients...`);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
