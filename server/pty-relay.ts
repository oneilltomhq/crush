/**
 * PTY WebSocket Relay
 *
 * Spawns real shell sessions via PTY and bridges them over WebSocket.
 * Each WebSocket connection gets its own PTY.
 *
 * Usage:
 *   npx tsx server/pty-relay.ts [--port 8091] [--shell /bin/bash]
 *
 * WebSocket protocol:
 *   Binary frames (both directions) = raw terminal data
 *   Text frames (client → server) = JSON control messages:
 *     { type: 'resize', cols: number, rows: number }
 *   Text frames (server → client) = JSON metadata:
 *     { type: 'meta', cols: number, rows: number, shell: string, pid: number }
 */

import { WebSocketServer, WebSocket } from 'ws';
import * as pty from 'node-pty';

const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '8091');
const SHELL = process.argv.find((_, i, a) => a[i - 1] === '--shell') || process.env.SHELL || '/bin/bash';
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const wss = new WebSocketServer({ port: WS_PORT });
console.log(`PTY relay listening on ws://localhost:${WS_PORT}`);
console.log(`Shell: ${SHELL}`);

wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected, spawning PTY...');

  const term = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd: process.env.HOME || '/home/exedev',
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    } as Record<string, string>,
  });

  console.log(`PTY spawned: pid=${term.pid}, ${DEFAULT_COLS}x${DEFAULT_ROWS}`);

  // Send metadata
  ws.send(JSON.stringify({
    type: 'meta',
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    shell: SHELL,
    pid: term.pid,
  }));

  // PTY → WebSocket (binary)
  term.onData((data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(Buffer.from(data, 'binary'));
    }
  });

  term.onExit(({ exitCode, signal }) => {
    console.log(`PTY exited: code=${exitCode}, signal=${signal}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'exit', exitCode, signal }));
      ws.close();
    }
  });

  // WebSocket → PTY
  ws.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (isBinary || Buffer.isBuffer(data)) {
      // Raw terminal input
      term.write(data.toString('binary'));
    } else {
      // Control message
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          term.resize(msg.cols, msg.rows);
          console.log(`Resized to ${msg.cols}x${msg.rows}`);
        }
      } catch {
        // Not JSON, treat as terminal input
        term.write(data.toString());
      }
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected, killing PTY');
    term.kill();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    term.kill();
  });
});
