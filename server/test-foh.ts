/**
 * test-foh.ts — Quick test of the FOH/worker architecture.
 * Connects to agent-server, triggers a greeting + research delegation.
 */
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8092');
let step = 0;
const startTime = Date.now();
function elapsed() { return `${((Date.now() - startTime) / 1000).toFixed(1)}s`; }

ws.on('open', () => {
  console.log(`[${elapsed()}] connected`);
  ws.send(JSON.stringify({ type: 'start' }));
});

ws.on('message', (raw: Buffer) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === 'init') {
    // skip
  } else if (msg.type === 'thinking') {
    console.log(`[${elapsed()}] thinking...`);
  } else if (msg.type === 'response') {
    console.log(`[${elapsed()}] SPOKE: "${msg.text}"`);
    step++;
    if (step === 1) {
      // After greeting, send research task
      setTimeout(() => {
        console.log(`\n[${elapsed()}] >>> Sending research request`);
        ws.send(JSON.stringify({ type: 'text', text: 'Research what senior TypeScript developers charge for contract work in 2025.' }));
      }, 300);
    } else if (step === 2) {
      // After delegation response, wait and check status
      setTimeout(() => {
        console.log(`\n[${elapsed()}] >>> Checking status`);
        ws.send(JSON.stringify({ type: 'text', text: "How's that research going?" }));
      }, 5000);
    } else if (step >= 3) {
      // Done with active testing, just wait for worker to complete
      console.log(`[${elapsed()}] (waiting for worker to finish...)`);
    }
  } else if (msg.type === 'command') {
    console.log(`[${elapsed()}] cmd: ${msg.name} ${JSON.stringify(msg.input).substring(0, 80)}`);
  } else if (msg.type === 'worker_complete' || msg.type === 'research_complete') {
    console.log(`\n[${elapsed()}] ✅ WORKER COMPLETE: ${(msg.summary || '').substring(0, 150)}`);
    setTimeout(() => { ws.close(); process.exit(0); }, 500);
  } else if (msg.type === 'worker_error' || msg.type === 'research_error') {
    console.log(`\n[${elapsed()}] ❌ WORKER ERROR: ${msg.error}`);
    ws.close(); process.exit(1);
  } else {
    // Log other events briefly
    const brief = JSON.stringify(msg).substring(0, 100);
    if (!brief.includes('research_progress')) console.log(`[${elapsed()}] ${msg.type}: ${brief}`);
  }
});

ws.on('error', (e: Error) => { console.error('ws error:', e.message); process.exit(1); });
setTimeout(() => { console.log('\n[timeout after 180s]'); ws.close(); process.exit(1); }, 180000);
