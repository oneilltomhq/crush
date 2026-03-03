/**
 * test-foh.ts — Test FOH/worker architecture including Phase 4 (proactive push).
 *
 * Tests:
 *   1. Greeting (< 1s)
 *   2. Task delegation (< 3s)
 *   3. Proactive notification when worker completes (no user prompt needed)
 *
 * Uses a shell worker (fast) to keep test time reasonable.
 */
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8092');
let step = 0;
let delegationResponseTime = 0;
let workerCompleteTime = 0;
let proactiveResponseTime = 0;
let gotProactiveResponse = false;
let gotWorkerComplete = false;
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
      // After greeting, delegate a fast shell task
      setTimeout(() => {
        console.log(`\n[${elapsed()}] >>> Delegating shell task (echo test)`);
        ws.send(JSON.stringify({ type: 'text', text: 'Run a quick shell command: echo "hello from worker" && date' }));
      }, 300);
    } else if (step === 2) {
      // Got delegation confirmation — now DON'T send anything.
      // Wait for the proactive push notification.
      delegationResponseTime = Date.now() - startTime;
      console.log(`[${elapsed()}] Delegation confirmed in ${(delegationResponseTime / 1000).toFixed(1)}s`);
      console.log(`[${elapsed()}] (waiting silently for proactive notification...)`);
    } else if (step >= 3 && gotWorkerComplete) {
      // This is the proactive response!
      proactiveResponseTime = Date.now() - startTime;
      gotProactiveResponse = true;
      console.log(`\n[${elapsed()}] ✅ PROACTIVE NOTIFICATION received!`);
      console.log(`   Delegation: ${(delegationResponseTime / 1000).toFixed(1)}s`);
      console.log(`   Worker done: ${(workerCompleteTime / 1000).toFixed(1)}s`);
      console.log(`   Proactive push: ${(proactiveResponseTime / 1000).toFixed(1)}s`);
      console.log(`   Push latency (worker_done → spoken): ${((proactiveResponseTime - workerCompleteTime) / 1000).toFixed(1)}s`);
      setTimeout(() => { ws.close(); process.exit(0); }, 300);
    }
  } else if (msg.type === 'command') {
    console.log(`[${elapsed()}] cmd: ${msg.name} ${JSON.stringify(msg.input).substring(0, 80)}`);
  } else if (msg.type === 'worker_complete') {
    workerCompleteTime = Date.now() - startTime;
    gotWorkerComplete = true;
    console.log(`[${elapsed()}] worker_complete event (raw WS): ${(msg.summary || '').substring(0, 100)}`);
  } else if (msg.type === 'worker_error') {
    console.log(`[${elapsed()}] ❌ WORKER ERROR: ${msg.error}`);
    ws.close(); process.exit(1);
  } else {
    const brief = JSON.stringify(msg).substring(0, 100);
    if (!brief.includes('research_progress')) console.log(`[${elapsed()}] ${msg.type}: ${brief}`);
  }
});

ws.on('error', (e: Error) => { console.error('ws error:', e.message); process.exit(1); });

// Safety timeout — if no proactive push within 60s, fail
setTimeout(() => {
  if (!gotProactiveResponse) {
    console.error(`\n[${elapsed()}] ❌ TIMEOUT: No proactive notification received in 60s`);
    ws.close();
    process.exit(1);
  }
}, 60000);
