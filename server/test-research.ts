/**
 * test-research.ts — CLI harness to trigger the research pipeline via
 * the running agent-server WebSocket. Sends a text message, logs all
 * responses (thinking, tool calls, research progress, final report).
 *
 * Usage: npx tsx server/test-research.ts "<research goal>"
 */

import WebSocket from 'ws';
import fs from 'fs';

const WS_URL = process.env.WS_URL || 'ws://localhost:8092';
const goal = process.argv.slice(2).join(' ') || 'London tech startup clusters: geography, key companies, recent funding, and coworking hubs';

console.log(`Connecting to ${WS_URL}...`);
console.log(`Research goal: ${goal}\n`);

const ws = new WebSocket(WS_URL);
let startTime = Date.now();

function elapsed(): string {
  return `+${((Date.now() - startTime) / 1000).toFixed(1)}s`;
}

ws.on('open', () => {
  console.log(`[${elapsed()}] Connected. Sending research request...\n`);
  // Ask the voice agent to research — it should invoke the research tool
  ws.send(JSON.stringify({
    type: 'text',
    text: `Research this topic thoroughly: ${goal}`,
  }));
});

ws.on('message', (data) => {
  try {
    const msg = JSON.parse(data.toString());
    switch (msg.type) {
      case 'init':
        console.log(`[${elapsed()}] init (${Object.keys(msg).join(', ')})`);
        break;
      case 'thinking':
        console.log(`[${elapsed()}] thinking...`);
        break;
      case 'response':
        console.log(`[${elapsed()}] RESPONSE: ${msg.text}\n`);
        break;
      case 'command':
        console.log(`[${elapsed()}] command: ${msg.name}`, msg.input?.label || msg.input?.pane_type || '');
        if (msg.name === 'update_text_pane' && msg.input?.content) {
          // Show research notes updates
          const content = msg.input.content;
          if (content.length < 500) {
            console.log(`  content: ${content.substring(0, 300)}\n`);
          } else {
            console.log(`  content: (${content.length} chars) ${content.substring(0, 150)}...\n`);
          }
          // Always write latest content to file
          fs.writeFileSync('/tmp/research-report.md', content);
          console.log(`  (written to /tmp/research-report.md)`);
        }
        break;
      case 'research_progress':
        console.log(`[${elapsed()}] progress: ${msg.message}`);
        break;
      case 'research_complete':
        console.log(`\n[${elapsed()}] === RESEARCH COMPLETE ===`);
        console.log(`Summary: ${msg.summary}\n`);
        // Write the final report
        setTimeout(() => {
          console.log('Done. Exiting.');
          ws.close();
          process.exit(0);
        }, 2000);
        break;
      case 'research_error':
        console.error(`[${elapsed()}] RESEARCH ERROR: ${msg.error}`);
        break;
      case 'error':
        console.error(`[${elapsed()}] ERROR: ${msg.message}`);
        break;
      default:
        console.log(`[${elapsed()}] ${msg.type}:`, JSON.stringify(msg).substring(0, 200));
    }
  } catch (e) {
    console.log(`[${elapsed()}] raw:`, data.toString().substring(0, 200));
  }
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log(`[${elapsed()}] Connection closed.`);
});

// Timeout after 5 minutes
setTimeout(() => {
  console.log('\nTimeout (5 min). Closing.');
  ws.close();
  process.exit(1);
}, 5 * 60 * 1000);
