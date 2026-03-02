#!/usr/bin/env node
/**
 * bridge-client.js — Run on the user's local machine.
 *
 * Tunnels their Chrome's CDP to the crush server so the agent can
 * automate the user's authenticated browser.
 *
 * Usage:
 *   node bridge-client.js ws://your-server:9230/tunnel
 *   node bridge-client.js ws://your-server:9230/tunnel --chrome-port 9222
 *
 * Prerequisites:
 *   - Chrome running with --remote-debugging-port=9222
 *   - npm install ws
 */

const WebSocket = require('ws');
const http = require('http');

const serverUrl = process.argv[2];
if (!serverUrl) {
  console.error('Usage: node bridge-client.js <server-ws-url> [--chrome-port <port>]');
  console.error('Example: node bridge-client.js ws://your-server:9230/tunnel');
  process.exit(1);
}

const chromePortIdx = process.argv.indexOf('--chrome-port');
const CHROME_PORT = chromePortIdx >= 0 ? parseInt(process.argv[chromePortIdx + 1]) : 9222;
const CHROME_HOST = 'localhost';

// Map channel IDs to WebSocket connections to Chrome targets
const channels = new Map();

let tunnel = null;
let reconnectTimer = null;

function log(msg) {
  console.log(`[bridge] ${new Date().toISOString().slice(11, 19)} ${msg}`);
}

// ---------------------------------------------------------------------------
// Chrome CDP HTTP proxy
// ---------------------------------------------------------------------------

function chromeHttpRequest(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${CHROME_HOST}:${CHROME_PORT}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Chrome CDP WebSocket proxy (per-channel)
// ---------------------------------------------------------------------------

async function getDefaultWsEndpoint() {
  const res = await chromeHttpRequest('/json/version');
  const data = JSON.parse(res.body);
  return data.webSocketDebuggerUrl;
}

async function ensureChannel(channelId) {
  if (channels.has(channelId)) return channels.get(channelId);

  const wsUrl = await getDefaultWsEndpoint();
  const ws = new WebSocket(wsUrl);

  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      channels.set(channelId, ws);
      log(`Channel ${channelId} connected to Chrome`);
      resolve(ws);
    });

    ws.on('message', (data) => {
      // Forward CDP response back through the tunnel
      if (tunnel && tunnel.readyState === WebSocket.OPEN) {
        tunnel.send(JSON.stringify({
          type: 'cdp',
          id: channelId,
          data: data.toString(),
        }));
      }
    });

    ws.on('close', () => {
      channels.delete(channelId);
      log(`Channel ${channelId} closed`);
    });

    ws.on('error', (err) => {
      channels.delete(channelId);
      reject(err);
    });
  });
}

function closeAllChannels() {
  for (const [id, ws] of channels) {
    ws.close();
  }
  channels.clear();
}

// ---------------------------------------------------------------------------
// Tunnel connection
// ---------------------------------------------------------------------------

function connect() {
  log(`Connecting to ${serverUrl}...`);
  tunnel = new WebSocket(serverUrl);

  tunnel.on('open', () => {
    log('Connected to server');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  tunnel.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === 'cdp') {
      // Forward CDP command to Chrome
      try {
        const ws = await ensureChannel(msg.id);
        ws.send(msg.data);
      } catch (err) {
        log(`Failed to connect channel ${msg.id}: ${err.message}`);
      }
    } else if (msg.type === 'http-request') {
      // Proxy HTTP request to Chrome
      try {
        const res = await chromeHttpRequest(msg.path);
        tunnel.send(JSON.stringify({
          type: 'http-response',
          id: msg.id,
          status: res.status,
          body: res.body,
        }));
      } catch (err) {
        tunnel.send(JSON.stringify({
          type: 'http-response',
          id: msg.id,
          status: 502,
          body: JSON.stringify({ error: err.message }),
        }));
      }
    }
  });

  tunnel.on('close', () => {
    log('Disconnected from server');
    closeAllChannels();
    scheduleReconnect();
  });

  tunnel.on('error', (err) => {
    log(`Connection error: ${err.message}`);
    // close event will fire after this
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  log('Reconnecting in 3s...');
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 3000);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

log(`Chrome CDP: ${CHROME_HOST}:${CHROME_PORT}`);
log(`Server: ${serverUrl}`);
connect();

process.on('SIGINT', () => {
  log('Shutting down...');
  closeAllChannels();
  if (tunnel) tunnel.close();
  process.exit(0);
});
