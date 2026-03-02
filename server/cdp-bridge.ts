/**
 * CDP Bridge
 *
 * WebSocket relay that bridges a user's local Chrome CDP to the crush server.
 *
 * Architecture:
 *   User's machine: Chrome (localhost:9222) ←→ bridge-client.js ←→ (internet)
 *   Server:         (internet) ←→ CdpBridge ←→ patchright/agent-browser
 *
 * The bridge client connects to CdpBridge via WebSocket. CdpBridge then
 * exposes a local CDP-compatible endpoint that patchright can connect to.
 *
 * Bridge protocol (over the tunnel WebSocket):
 *   Client → Server:  { type: 'cdp',  id: string, data: string }   (CDP WS message from browser)
 *   Server → Client:  { type: 'cdp',  id: string, data: string }   (CDP WS message to browser)
 *   Client → Server:  { type: 'http-response', id: string, status: number, body: string }
 *   Server → Client:  { type: 'http-request', id: string, method: string, path: string }
 */

import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';

export interface CdpBridgeOptions {
  /** Timeout for HTTP requests proxied through the bridge (ms). Default: 10000 */
  httpTimeout?: number;
}

interface PendingHttpRequest {
  resolve: (value: { status: number; body: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CdpBridge {
  private httpServer: http.Server | null = null;
  private tunnelWss: WebSocketServer | null = null;
  private localWss: WebSocketServer | null = null;
  private bridgeClient: WebSocket | null = null;
  private port = 0;
  private httpTimeout: number;

  // Maps a local CDP client WS to a unique channel id so multiple
  // patchright connections can share the single tunnel.
  private localClients = new Map<WebSocket, string>();
  private channelToLocal = new Map<string, WebSocket>();
  private nextChannelId = 1;

  // Pending HTTP requests forwarded through the tunnel
  private pendingHttp = new Map<string, PendingHttpRequest>();
  private nextHttpId = 1;

  constructor(options: CdpBridgeOptions = {}) {
    this.httpTimeout = options.httpTimeout ?? 10_000;
  }

  /**
   * Start the bridge server.
   * - Accepts tunnel connections from bridge-client on /tunnel
   * - Exposes CDP-compatible endpoints on /devtools/browser/bridged
   * - Proxies /json/version and /json/list HTTP requests through the tunnel
   */
  async start(port: number): Promise<void> {
    this.port = port;

    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    // Tunnel WSS: bridge client connects here
    this.tunnelWss = new WebSocketServer({ noServer: true });

    // Local WSS: patchright/agent connects here (CDP-compatible)
    this.localWss = new WebSocketServer({ noServer: true });

    this.httpServer.on('upgrade', (req, socket, head) => {
      const url = req.url || '';
      if (url === '/tunnel') {
        this.tunnelWss!.handleUpgrade(req, socket, head, (ws) => {
          this.tunnelWss!.emit('connection', ws, req);
        });
      } else if (url.startsWith('/devtools/')) {
        this.localWss!.handleUpgrade(req, socket, head, (ws) => {
          this.localWss!.emit('connection', ws, req);
        });
      } else {
        socket.destroy();
      }
    });

    this.tunnelWss.on('connection', (ws) => {
      this.handleTunnelConnection(ws);
    });

    this.localWss.on('connection', (ws) => {
      this.handleLocalConnection(ws);
    });

    return new Promise<void>((resolve, reject) => {
      this.httpServer!.on('error', reject);
      this.httpServer!.listen(port, () => resolve());
    });
  }

  /** Stop the bridge server and close all connections. */
  async stop(): Promise<void> {
    // Close all local clients
    for (const ws of this.localClients.keys()) {
      ws.close();
    }
    this.localClients.clear();
    this.channelToLocal.clear();

    // Close bridge client
    if (this.bridgeClient) {
      this.bridgeClient.close();
      this.bridgeClient = null;
    }

    // Reject pending HTTP requests
    for (const [, pending] of this.pendingHttp) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Bridge stopped'));
    }
    this.pendingHttp.clear();

    // Close servers
    this.tunnelWss?.close();
    this.localWss?.close();

    return new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  /**
   * Returns the local CDP WebSocket URL that patchright can connect to.
   */
  getEndpoint(): string {
    return `ws://localhost:${this.port}/devtools/browser/bridged`;
  }

  /**
   * Whether a bridge client is currently connected.
   */
  isConnected(): boolean {
    return this.bridgeClient !== null && this.bridgeClient.readyState === WebSocket.OPEN;
  }

  // ---------------------------------------------------------------------------
  // Tunnel connection (bridge-client.js → server)
  // ---------------------------------------------------------------------------

  private handleTunnelConnection(ws: WebSocket): void {
    // Only one bridge client at a time; newer one replaces older
    if (this.bridgeClient && this.bridgeClient.readyState === WebSocket.OPEN) {
      this.bridgeClient.close(1000, 'Replaced by new connection');
    }
    this.bridgeClient = ws;

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleTunnelMessage(msg);
      } catch {
        // Ignore malformed messages
      }
    });

    ws.on('close', () => {
      if (this.bridgeClient === ws) {
        this.bridgeClient = null;
      }
      // Close all local CDP clients since the bridge is gone
      for (const localWs of this.localClients.keys()) {
        localWs.close(1001, 'Bridge disconnected');
      }
      this.localClients.clear();
      this.channelToLocal.clear();

      // Reject pending HTTP requests
      for (const [, pending] of this.pendingHttp) {
        clearTimeout(pending.timer);
        pending.reject(new Error('Bridge disconnected'));
      }
      this.pendingHttp.clear();
    });

    ws.on('error', () => {
      // Will trigger close
    });
  }

  private handleTunnelMessage(msg: any): void {
    if (msg.type === 'cdp') {
      // Forward CDP message to the appropriate local client
      const localWs = this.channelToLocal.get(msg.id);
      if (localWs && localWs.readyState === WebSocket.OPEN) {
        localWs.send(msg.data);
      }
    } else if (msg.type === 'http-response') {
      // Resolve a pending HTTP request
      const pending = this.pendingHttp.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingHttp.delete(msg.id);
        pending.resolve({ status: msg.status, body: msg.body });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Local CDP connections (patchright → bridge server)
  // ---------------------------------------------------------------------------

  private handleLocalConnection(ws: WebSocket): void {
    const channelId = `ch-${this.nextChannelId++}`;
    this.localClients.set(ws, channelId);
    this.channelToLocal.set(channelId, ws);

    ws.on('message', (raw) => {
      // Forward CDP message through the tunnel to the real browser
      if (this.bridgeClient && this.bridgeClient.readyState === WebSocket.OPEN) {
        this.bridgeClient.send(JSON.stringify({
          type: 'cdp',
          id: channelId,
          data: raw.toString(),
        }));
      }
    });

    ws.on('close', () => {
      this.localClients.delete(ws);
      this.channelToLocal.delete(channelId);
    });

    ws.on('error', () => {
      // Will trigger close
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP requests (proxied through the tunnel)
  // ---------------------------------------------------------------------------

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const path = req.url || '/';

    // Only proxy known CDP HTTP endpoints
    if (path !== '/json/version' && path !== '/json/list') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    if (!this.isConnected()) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bridge not connected');
      return;
    }

    const httpId = `http-${this.nextHttpId++}`;

    const timer = setTimeout(() => {
      this.pendingHttp.delete(httpId);
      res.writeHead(504, { 'Content-Type': 'text/plain' });
      res.end('Bridge timeout');
    }, this.httpTimeout);

    this.pendingHttp.set(httpId, {
      resolve: ({ status, body }) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
      },
      reject: (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(err.message);
        }
      },
      timer,
    });

    this.bridgeClient!.send(JSON.stringify({
      type: 'http-request',
      id: httpId,
      method: req.method || 'GET',
      path,
    }));
  }
}
