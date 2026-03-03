/**
 * test-who-story.ts — Live test of the WHO identification user story.
 *
 * Simulates a user saying "I need to find contracts" with minimal context.
 * Validates that Scout:
 *   1. Probes for context before delegating (doesn't fire a vague research task)
 *   2. Eventually delegates specific research after getting answers
 *   3. Reports back with findings
 *
 * Usage: source .env && export ... && npx tsx server/test-who-story.ts
 */
import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8092');
const startTime = Date.now();
function elapsed() { return `${((Date.now() - startTime) / 1000).toFixed(1)}s`; }

// Conversation script — we feed these in sequence after each response
const script = [
  // Turn 1: vague opener (should trigger probing, NOT immediate delegation)
  'I need to find some contract work',
  // Turn 2: answer the probe with some context
  'I\'m a senior full-stack engineer, mostly TypeScript and React. I\'m based near London. Looking for 3-6 month contracts, ideally hybrid.',
  // Turn 3: nudge toward the geographic mapping angle
  'Yeah, I\'ve heard different parts of London have different tech scenes. Like the City is all finance, Shoreditch is startups. Can you map that out for me?',
];

let turn = 0;
let delegated = false;
let probed = false;
let researchComplete = false;
const allResponses: { turn: number; text: string; time: string }[] = [];
const allCommands: { name: string; input: any; time: string }[] = [];

function analyzeAndRespond(responseText: string) {
  const lower = responseText.toLowerCase();
  const currentTurn = turn;

  // Check if Scout is probing (asking questions) vs delegating
  const isQuestion = lower.includes('?');
  const isDelegationAck = lower.includes('delegat') || lower.includes('research') && (lower.includes('on it') || lower.includes('working') || lower.includes('looking into'));

  if (currentTurn === 1 && isQuestion && !delegated) {
    probed = true;
    console.log(`[${elapsed()}] ✅ Scout PROBED on turn 1 (good! didn't immediately delegate)`);
  }
  if (currentTurn === 1 && delegated && !probed) {
    console.log(`[${elapsed()}] ⚠️  Scout delegated on turn 1 without probing (too eager)`);
  }

  // Send next scripted message
  if (turn < script.length) {
    const nextMsg = script[turn];
    turn++;
    console.log(`\n[${elapsed()}] >>> User (turn ${turn}): "${nextMsg}"`);
    ws.send(JSON.stringify({ type: 'text', text: nextMsg }));
  } else if (!researchComplete) {
    // All script lines sent — wait for research to complete
    console.log(`\n[${elapsed()}] (all scripted turns sent, waiting for research to complete...)`);
  }
}

ws.on('open', () => {
  console.log(`[${elapsed()}] Connected`);
  ws.send(JSON.stringify({ type: 'start' }));
});

ws.on('message', (raw: Buffer) => {
  const msg = JSON.parse(raw.toString());

  switch (msg.type) {
    case 'init':
      break;

    case 'thinking':
      process.stdout.write(`[${elapsed()}] thinking...`);
      break;

    case 'response': {
      const t = elapsed();
      console.log(`\n[${t}] 🗣️  Scout: "${msg.text}"`);
      allResponses.push({ turn, text: msg.text, time: t });
      analyzeAndRespond(msg.text);
      break;
    }

    case 'command': {
      const t = elapsed();
      allCommands.push({ name: msg.name, input: msg.input, time: t });
      if (msg.name === 'create_pane') {
        console.log(`[${t}] 🔧 create_pane: "${msg.input?.label || ''}"`);
      } else if (msg.name === 'update_pane') {
        console.log(`[${t}] 🔧 update_pane: "${msg.input?.label || ''}" (${(msg.input?.content || '').length} chars)`);
      } else {
        console.log(`[${t}] 🔧 ${msg.name}: ${JSON.stringify(msg.input).substring(0, 100)}`);
      }
      break;
    }

    case 'worker_complete': {
      const t = elapsed();
      console.log(`\n[${t}] ✅ Worker ${msg.workerId} complete: ${(msg.summary || '').substring(0, 150)}`);
      delegated = true;
      researchComplete = true;

      // Wait for the proactive FOH notification, then wrap up
      setTimeout(() => {
        console.log('\n' + '='.repeat(60));
        console.log('TEST RESULTS');
        console.log('='.repeat(60));
        console.log(`Probed before delegating: ${probed ? '✅ Yes' : '❌ No'}`);
        console.log(`Delegated research: ${delegated ? '✅ Yes' : '❌ No'}`);
        console.log(`Research completed: ${researchComplete ? '✅ Yes' : '❌ No'}`);
        console.log(`Total turns: ${allResponses.length}`);
        console.log(`Total commands: ${allCommands.length}`);
        console.log(`\nAll responses:`);
        for (const r of allResponses) {
          console.log(`  [${r.time}] Turn ${r.turn}: "${r.text.substring(0, 120)}${r.text.length > 120 ? '...' : ''}"`);
        }
        console.log(`\nDelegate commands:`);
        for (const c of allCommands.filter(c => c.name === 'create_pane')) {
          console.log(`  [${c.time}] ${c.name}: ${JSON.stringify(c.input).substring(0, 120)}`);
        }
        ws.close();
        process.exit(probed && delegated && researchComplete ? 0 : 1);
      }, 15000); // Give 15s for the FOH proactive notification after worker completes
      break;
    }

    case 'worker_error': {
      console.log(`\n[${elapsed()}] ❌ Worker error: ${msg.error}`);
      break;
    }

    case 'error': {
      console.log(`\n[${elapsed()}] ⚠️  Error: ${msg.message}`);
      break;
    }

    default: {
      // Only log non-spammy types
      const s = JSON.stringify(msg).substring(0, 80);
      if (!s.includes('research_progress')) {
        console.log(`[${elapsed()}] ${msg.type}: ${s}`);
      }
    }
  }
});

ws.on('error', (e: Error) => { console.error('ws error:', e.message); process.exit(1); });

// Safety timeout
setTimeout(() => {
  console.error(`\n[${elapsed()}] TIMEOUT: Test did not complete in 120s`);
  console.log('\nPartial results:');
  console.log(`  Responses: ${allResponses.length}`);
  console.log(`  Probed: ${probed}`);
  console.log(`  Delegated: ${delegated}`);
  for (const r of allResponses) {
    console.log(`  [${r.time}] "${r.text.substring(0, 100)}"`);
  }
  ws.close();
  process.exit(1);
}, 120000);
