/**
 * Tests for the CDP bridge — WebSocket relay between user's browser and server.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import http from 'http';
import { CdpBridge } from '../server/cdp-bridge';

let nextPort = 19230;
function getPort() { return nextPort++; }

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.on('open', resolve);
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    ws.once('message', (data) => resolve(data.toString()));
  });
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${port}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
  });
}

describe('CdpBridge', () => {
  let bridge: CdpBridge;

  afterEach(async () => {
    if (bridge) await bridge.stop();
  });

  it('starts and reports not connected when no client', async () => {
    bridge = new CdpBridge();
    const TEST_PORT = getPort(); await bridge.start(TEST_PORT);
    expect(bridge.isConnected()).toBe(false);
    expect(bridge.getEndpoint()).toBe(`ws://localhost:${TEST_PORT}/devtools/browser/bridged`);
  });

  it('reports connected when bridge client connects', async () => {
    bridge = new CdpBridge();
    const TEST_PORT = getPort(); await bridge.start(TEST_PORT);

    const client = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`);
    await waitForOpen(client);

    expect(bridge.isConnected()).toBe(true);
    client.close();
  });

  it('reports not connected after bridge client disconnects', async () => {
    bridge = new CdpBridge();
    const TEST_PORT = getPort(); await bridge.start(TEST_PORT);

    const client = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`);
    await waitForOpen(client);
    expect(bridge.isConnected()).toBe(true);

    client.close();
    // Wait for close to propagate
    await new Promise((r) => setTimeout(r, 100));
    expect(bridge.isConnected()).toBe(false);
  });

  it('forwards CDP messages from local client through tunnel', async () => {
    bridge = new CdpBridge();
    const TEST_PORT = getPort(); await bridge.start(TEST_PORT);

    // Simulate bridge client (user's machine)
    const tunnelClient = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`);
    await waitForOpen(tunnelClient);

    // Simulate patchright connecting as a local CDP client
    const localClient = new WebSocket(`ws://localhost:${TEST_PORT}/devtools/browser/bridged`);
    await waitForOpen(localClient);

    // Local client sends a CDP command
    const tunnelMsg = waitForMessage(tunnelClient);
    localClient.send('{"id":1,"method":"Page.navigate","params":{"url":"https://example.com"}}');

    const received = JSON.parse(await tunnelMsg);
    expect(received.type).toBe('cdp');
    expect(received.id).toBeTruthy(); // channel ID
    expect(received.data).toContain('Page.navigate');

    localClient.close();
    tunnelClient.close();
  });

  it('forwards CDP responses back from tunnel to local client', async () => {
    bridge = new CdpBridge();
    const TEST_PORT = getPort(); await bridge.start(TEST_PORT);

    const tunnelClient = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`);
    await waitForOpen(tunnelClient);

    const localClient = new WebSocket(`ws://localhost:${TEST_PORT}/devtools/browser/bridged`);
    await waitForOpen(localClient);

    // Send a message from local to get the channel ID
    const tunnelMsg = waitForMessage(tunnelClient);
    localClient.send('{"id":1,"method":"test"}');
    const forwarded = JSON.parse(await tunnelMsg);
    const channelId = forwarded.id;

    // Now simulate a response coming back from Chrome through the tunnel
    const localMsg = waitForMessage(localClient);
    tunnelClient.send(JSON.stringify({
      type: 'cdp',
      id: channelId,
      data: '{"id":1,"result":{"frameId":"abc"}}',
    }));

    const response = await localMsg;
    expect(response).toContain('frameId');

    localClient.close();
    tunnelClient.close();
  });

  it('proxies HTTP /json/version through the tunnel', async () => {
    bridge = new CdpBridge({ httpTimeout: 3000 });
    const TEST_PORT = getPort(); await bridge.start(TEST_PORT);

    const tunnelClient = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`);
    await waitForOpen(tunnelClient);

    // Handle HTTP requests from the tunnel
    tunnelClient.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'http-request') {
        tunnelClient.send(JSON.stringify({
          type: 'http-response',
          id: msg.id,
          status: 200,
          body: JSON.stringify({ Browser: 'Chrome/test', webSocketDebuggerUrl: 'ws://test' }),
        }));
      }
    });

    const res = await httpGet(TEST_PORT, '/json/version');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.Browser).toBe('Chrome/test');

    tunnelClient.close();
  });

  it('returns 502 for HTTP requests when bridge not connected', async () => {
    bridge = new CdpBridge();
    const TEST_PORT = getPort(); await bridge.start(TEST_PORT);

    const res = await httpGet(TEST_PORT, '/json/version');
    expect(res.status).toBe(502);
  });

  it('returns 404 for unknown HTTP paths', async () => {
    bridge = new CdpBridge();
    const TEST_PORT = getPort(); await bridge.start(TEST_PORT);

    const res = await httpGet(TEST_PORT, '/unknown');
    expect(res.status).toBe(404);
  });

  it('newer bridge client replaces older one', async () => {
    bridge = new CdpBridge();
    const TEST_PORT = getPort(); await bridge.start(TEST_PORT);

    const client1 = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`);
    await waitForOpen(client1);
    expect(bridge.isConnected()).toBe(true);

    const client2 = new WebSocket(`ws://localhost:${TEST_PORT}/tunnel`);
    await waitForOpen(client2);
    expect(bridge.isConnected()).toBe(true);

    // Wait for client1 to be closed by the bridge
    await new Promise((r) => setTimeout(r, 100));
    expect(client1.readyState).not.toBe(WebSocket.OPEN);

    client2.close();
  });
});
