/**
 * cli-chat.ts — Interactive CLI chat with the agent server.
 *
 * Connects to ws://localhost:8092, sends a start message, then enters
 * a REPL loop for text exchange. Shows all server messages with timing.
 *
 * Usage: npx tsx server/cli-chat.ts [--port 8092]
 */
import WebSocket from 'ws';
import readline from 'readline';

const port = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '8092');
const ws = new WebSocket(`ws://localhost:${port}`);
const startTime = Date.now();
function elapsed() { return `${((Date.now() - startTime) / 1000).toFixed(1)}s`; }

const isTTY = process.stdin.isTTY;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let ready = false;
let inputClosed = false;

rl.on('close', () => { inputClosed = true; });

function prompt() {
  if (!ready || inputClosed) return;
  rl.question('\n> ', (text) => {
    if (inputClosed) return;
    if (!text.trim()) { prompt(); return; }
    if (text.trim() === '/quit' || text.trim() === '/exit') {
      console.log('Bye.');
      ws.close();
      process.exit(0);
    }
    ws.send(JSON.stringify({ type: 'text', text: text.trim() }));
    // Don't prompt again until we get a response
  });
}

ws.on('open', () => {
  console.log(`[${elapsed()}] Connected to ws://localhost:${port}`);
  ws.send(JSON.stringify({ type: 'start' }));
});

ws.on('message', (raw: Buffer) => {
  const msg = JSON.parse(raw.toString());

  switch (msg.type) {
    case 'init':
      console.log(`[${elapsed()}] Session initialized`);
      ready = true;
      break;

    case 'thinking':
      process.stdout.write(`[${elapsed()}] thinking...`);
      break;

    case 'response':
      console.log(`\n[${elapsed()}] 🗣️  ${msg.text}`);
      prompt();
      break;

    case 'command':
      console.log(`[${elapsed()}] 🔧 ${msg.name}: ${JSON.stringify(msg.input).substring(0, 120)}`);
      break;

    case 'worker_complete':
      console.log(`\n[${elapsed()}] ✅ Worker ${msg.workerId} done: ${(msg.summary || '').substring(0, 150)}`);
      break;

    case 'worker_error':
      console.log(`\n[${elapsed()}] ❌ Worker ${msg.workerId} error: ${msg.error}`);
      break;

    case 'error':
      console.log(`\n[${elapsed()}] ⚠️  ${msg.message}`);
      prompt();
      break;

    default: {
      const brief = JSON.stringify(msg).substring(0, 120);
      console.log(`[${elapsed()}] ${msg.type}: ${brief}`);
      break;
    }
  }
});

ws.on('close', () => {
  console.log(`\n[${elapsed()}] Disconnected`);
  rl.close();
  process.exit(0);
});

ws.on('error', (e: Error) => {
  console.error(`Connection error: ${e.message}`);
  process.exit(1);
});
