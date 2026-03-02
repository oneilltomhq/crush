/**
 * Agent Server — port 8092
 *
 * Text-in/text-out LLM agent loop using Pi agent-core.
 * STT and TTS are client-side (ADR 005).
 * Refactored per ADR 008 to use pi-agent-core Agent class.
 *
 * Protocol (JSON text frames):
 *
 * Client → Server:
 *   { type: 'text', text: '...' }  — User utterance
 *
 * Server → Client:
 *   { type: 'thinking' }           — LLM is processing
 *   { type: 'response', text }     — LLM spoken response (client handles TTS)
 *   { type: 'command', name, input } — Tool invocation to execute
 *   { type: 'error', message }      — Error
 *   { type: 'init', todo }          — Initial workspace state on connect
 */

import { WebSocketServer, WebSocket } from 'ws';
import { Agent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { registerBuiltInApiProviders, Type } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { Model, AssistantMessage } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { AgentTool, AgentEvent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { fohTools, shellWorkerTools, browserWorkerTools, readTodo, readProfile } from './pi-tools.js';
import { AgentRunner } from './agent-runner.js';
import { WorkerAgent, type WorkerType, type WorkerStatus } from './worker-agent.js';

// Register built-in API providers (Anthropic, etc.)
registerBuiltInApiProviders();

// ---------------------------------------------------------------------------
// Research model config — MiniMax M2.5 via OpenRouter (cheapest option)
// $0.30/$1.10 per Mtok, ~$0.05/research report
// ---------------------------------------------------------------------------
const RESEARCH_MODEL: Model<'openai-completions'> = {
  id: 'minimax/minimax-m2.5',
  name: 'MiniMax M2.5',
  api: 'openai-completions',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0.3, output: 1.1, cacheRead: 0.15, cacheWrite: 0 },
  contextWindow: 196608,
  maxTokens: 65536,
};

// ---------------------------------------------------------------------------
// FOH model — Llama 4 Scout via OpenRouter (Groq-hosted, fast inference)
// ~500ms round-trip, $0.08/$0.30 per Mtok
// ---------------------------------------------------------------------------
const FOH_MODEL: Model<'openai-completions'> = {
  id: 'meta-llama/llama-4-scout',
  name: 'Llama 4 Scout',
  api: 'openai-completions',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0.08, output: 0.3, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 327680,
  maxTokens: 1024,
};

// ---------------------------------------------------------------------------
// Worker model — Sonnet 4 via exe-gateway (capable, for shell/browser tasks)
// ---------------------------------------------------------------------------
const WORKER_MODEL: Model<'anthropic-messages'> = {
  id: 'claude-sonnet-4-20250514',
  name: 'Sonnet 4',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'http://169.254.169.254/gateway/llm/anthropic',
  reasoning: false,
  input: ['text'],
  cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
if (!OPENROUTER_KEY) console.warn('[agent-server] OPENROUTER_API_KEY not set — research/FOH will fail');

function resolveApiKey(provider: string): string {
  if (provider === 'openrouter') return OPENROUTER_KEY;
  return 'gateway'; // exe-gateway accepts any non-empty key
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  return val;
}

// Voice credentials — server-side, sent to client in init
const DEEPGRAM_API_KEY = requireEnv('DEEPGRAM_API_KEY');
const ELEVENLABS_API_KEY = requireEnv('ELEVENLABS_API_KEY');

const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '8092');



// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildFohSystemPrompt(): string {
  const todo = readTodo();
  const profile = readProfile();
  return `You are Crush — a fast voice assistant that delegates complex work to background workers.

The user speaks to you and you speak back via TTS. You are the front-of-house: always responsive, never slow.

## Voice rules (critical)

- Keep responses SHORT — 1-2 sentences. This is a conversation, not a monologue.
- No markdown formatting in speech. Just talk like a person.
- ALWAYS include spoken text in your response, even when using tools. Say what you're doing.
- Respond FAST. You must never leave the user in silence.

## How you work

You do NOT execute complex tasks yourself. You delegate to background workers:
- delegate_task with worker_type "research" — web research, competitive analysis, market research
- delegate_task with worker_type "shell" — system commands, coding, file operations, git, installs
- delegate_task with worker_type "browser" — web automation, CDP browsing, authenticated site actions

Workers run in the background. You can check on them with check_tasks and abort them with abort_task.

You DO handle directly (no delegation needed):
- Reading/writing local files (read_file, write_file) — these are instant
- Managing workspace panes (create_pane, remove_pane, scroll_pane)
- Updating the todo list
- Simple conversation and questions

## Confirmation rule

Before delegating any action on an external service (posting to X, editing LinkedIn, submitting forms, pushing to GitHub), ALWAYS:
1. Show the user what you plan to do
2. Ask for explicit approval
3. Only delegate when the user says yes

Research, reading, and local file drafting proceed without confirmation.

## Workspace

The user sees a 3D grid of panes. Create panes to show worker results, drafts, or information. Keep it clean.

## User profile

Persistent context in ~/.crush/profile/ (markdown files). Read these to understand the user. Update them when you learn new things.

${profile ? `### Current profile:\n\n${profile}` : 'No profile files yet. Save key facts to ~/.crush/profile/ as you learn about the user.'}

## Todo list

${todo}

Today is ${new Date().toISOString().split('T')[0]}.`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Extract spoken text from an assistant message's content blocks */
function extractText(msg: any): string {
  if (msg.role !== 'assistant') return '';
  return msg.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join(' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

interface Connection {
  ws: WebSocket;
  id: string;
  agent: Agent;          // FOH agent (Scout)
  processing: boolean;
  workers: Map<string, WorkerAgent | AgentRunner>;  // background workers
  workerCounter: number;
}

// ---------------------------------------------------------------------------
// Worker system prompts
// ---------------------------------------------------------------------------

const SHELL_WORKER_PROMPT = `You are a shell/coding worker agent. Execute the given task using shell commands, file operations, and web searches.

You have full system access. Working directory is /home/exedev/crush.
Be thorough but efficient. When done, summarize what you did and the outcome.`;

const BROWSER_WORKER_PROMPT = `You are a browser automation worker agent. Execute the given task using CDP browser automation.

Tools:
- browse: control the server's headless Chromium (for general browsing)
- auth_browse: control the user's authenticated browser (for logged-in sites: LinkedIn, X, Gmail, etc.)
- web_search: Tavily search for information lookup

Workflow: open URL → snapshot -i → interact with @refs → verify result.
Be careful with auth_browse — you're controlling the user's real browser sessions.
When done, summarize what you did and the outcome.`;

// ---------------------------------------------------------------------------
// Build FOH tools for a connection (includes delegation tools)
// ---------------------------------------------------------------------------

function buildFohTools(conn: Connection): AgentTool[] {
  const tools = fohTools(conn.ws);

  // delegate_task — creates a background worker
  const delegateTaskTool: AgentTool = {
    name: 'delegate_task',
    label: 'Delegate Task',
    description: `Delegate a task to a background worker agent. Returns immediately — the worker runs async.
Worker types:
- research: deep web research with parallel sub-queries. Use for any research, analysis, or information gathering.
- shell: system commands, coding, file operations, git, package management.
- browser: CDP browser automation, web scraping, authenticated site actions (LinkedIn, X, etc.).`,
    parameters: Type.Object({
      task: Type.String({ description: 'Clear, specific description of what to accomplish' }),
      worker_type: Type.Union([
        Type.Literal('research'),
        Type.Literal('shell'),
        Type.Literal('browser'),
      ], { description: 'Type of worker to use' }),
    }),
    execute: async (_id, params) => {
      const { task, worker_type } = params as { task: string; worker_type: WorkerType };
      const workerId = `w${++conn.workerCounter}`;
      const tag = `[worker:${workerId}]`;

      console.log(`${tag} Delegating ${worker_type}: "${task.substring(0, 80)}"`);

      if (worker_type === 'research') {
        // Use the specialized AgentRunner for research (3-phase pipeline)
        const notesPaneLabel = `Research: ${task.substring(0, 40)}${task.length > 40 ? '...' : ''}`;
        send(conn.ws, {
          type: 'command', name: 'create_pane',
          input: { pane_type: 'text', label: notesPaneLabel, content: `# Researching...\n\n*${task}*\n\nStarting research agent...` },
        });

        const runner = new AgentRunner({
          goal: task,
          ws: conn.ws,
          notesPaneLabel,
          model: RESEARCH_MODEL,
          getApiKey: resolveApiKey,
          onComplete: (summary) => {
            console.log(`${tag} Complete: ${summary.substring(0, 80)}`);
            send(conn.ws, { type: 'worker_complete', workerId, summary });
          },
          onProgress: (status) => console.log(`${tag} ${status}`),
          onError: (err) => {
            console.error(`${tag} Error: ${err}`);
            send(conn.ws, { type: 'worker_error', workerId, error: err });
          },
        });
        conn.workers.set(workerId, runner);
        runner.start();
      } else {
        // Use generic WorkerAgent for shell/browser tasks
        const workerTools = worker_type === 'shell'
          ? shellWorkerTools()
          : browserWorkerTools(conn.ws);
        const workerPrompt = worker_type === 'shell'
          ? SHELL_WORKER_PROMPT
          : BROWSER_WORKER_PROMPT;

        // Create a pane for the worker's output
        const paneLabel = `${worker_type}: ${task.substring(0, 35)}${task.length > 35 ? '...' : ''}`;
        send(conn.ws, {
          type: 'command', name: 'create_pane',
          input: { pane_type: 'text', label: paneLabel, content: `*Working on: ${task}*\n\nStarting...` },
        });

        const worker = new WorkerAgent({
          id: workerId,
          type: worker_type,
          goal: task,
          model: WORKER_MODEL,
          tools: workerTools,
          systemPrompt: workerPrompt,
          getApiKey: resolveApiKey,
          onProgress: (wId, msg) => console.log(`${tag} ${msg}`),
          onComplete: (wId, result) => {
            console.log(`${tag} Complete (${result.length} chars)`);
            // Update the worker's pane with the result
            send(conn.ws, {
              type: 'command', name: 'update_pane',
              input: { label: paneLabel, content: result },
            });
            send(conn.ws, { type: 'worker_complete', workerId: wId, summary: result.substring(0, 200) });
          },
          onError: (wId, err) => {
            console.error(`${tag} Error: ${err}`);
            send(conn.ws, { type: 'worker_error', workerId: wId, error: err });
          },
        });
        conn.workers.set(workerId, worker);
        worker.start();
      }

      return {
        content: [{ type: 'text', text: `Task delegated to ${worker_type} worker (${workerId}). Running in background.` }],
        details: { workerId },
      };
    },
  };

  // check_tasks — report on worker status
  const checkTasksTool: AgentTool = {
    name: 'check_tasks',
    label: 'Check Tasks',
    description: 'Check status of background workers. Use when user asks how things are going.',
    parameters: Type.Object({}),
    execute: async () => {
      if (conn.workers.size === 0) {
        return { content: [{ type: 'text', text: 'No background tasks running.' }], details: {} };
      }
      const lines: string[] = [];
      for (const [id, w] of conn.workers) {
        if (w instanceof AgentRunner) {
          const s = w.getStatus();
          lines.push(`${id} [research] "${s.goal.substring(0, 50)}" — ${s.state}`);
        } else {
          const s = w.getStatus();
          const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
          lines.push(`${id} [${s.type}] "${s.goal.substring(0, 50)}" — ${s.state} (${elapsed}s)`);
          if (s.result) lines.push(`  Result: ${s.result.substring(0, 100)}...`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    },
  };

  // abort_task — cancel a running worker
  const abortTaskTool: AgentTool = {
    name: 'abort_task',
    label: 'Abort Task',
    description: 'Abort a background worker by ID. Use when user wants to cancel a task.',
    parameters: Type.Object({
      worker_id: Type.String({ description: 'Worker ID to abort (e.g. w1, w2)' }),
    }),
    execute: async (_id, params) => {
      const wId = (params as { worker_id: string }).worker_id;
      const worker = conn.workers.get(wId);
      if (!worker) {
        return { content: [{ type: 'text', text: `No worker found with ID ${wId}.` }], details: {} };
      }
      worker.abort();
      return { content: [{ type: 'text', text: `Worker ${wId} aborted.` }], details: {} };
    },
  };

  tools.push(delegateTaskTool, checkTasksTool, abortTaskTool);
  return tools;
}

// ---------------------------------------------------------------------------
// Process conversation start — agent speaks first
// ---------------------------------------------------------------------------

async function processStart(conn: Connection): Promise<void> {
  if (conn.processing) return;
  conn.processing = true;
  const tag = `[foh:${conn.id}]`;
  console.log(`${tag} Conversation started`);

  try {
    send(conn.ws, { type: 'thinking' });

    const todo = readTodo();
    const hasTodo = todo && !todo.includes('No todo file found');
    const prompt = hasTodo
      ? '[System: The user just opened Crush. They have a todo list. Greet briefly, mention it, ask what to tackle. One sentence + one question.]'
      : '[System: The user just opened Crush. Say hi in one sentence, ask what they want to work on. Do NOT list features.]';

    await conn.agent.prompt(prompt);

    // Extract the last assistant response
    const messages = conn.agent.state.messages;
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const spoken = lastAssistant ? extractText(lastAssistant) : '';

    if (spoken) {
      send(conn.ws, { type: 'response', text: spoken });
      console.log(`${tag} Opening: "${spoken.substring(0, 100)}"`);
    }
  } catch (err: any) {
    console.error(`${tag} Start error:`, err.message);
    send(conn.ws, { type: 'error', message: err.message });
  } finally {
    conn.processing = false;
  }
}

// ---------------------------------------------------------------------------
// Process user text — Pi Agent handles the full tool-use loop
// ---------------------------------------------------------------------------

async function processText(conn: Connection, userText: string): Promise<void> {
  if (!userText.trim()) return;
  if (conn.processing) {
    send(conn.ws, { type: 'error', message: 'Still processing previous request' });
    return;
  }

  conn.processing = true;
  const tag = `[foh:${conn.id}]`;
  console.log(`${tag} "${userText.substring(0, 80)}${userText.length > 80 ? '...' : ''}"`);

  try {
    send(conn.ws, { type: 'thinking' });

    // FOH agent stays lean — keep last 20 messages
    if (conn.agent.state.messages.length > 20) {
      const trimmed = conn.agent.state.messages.slice(-20);
      conn.agent.replaceMessages(trimmed);
    }

    // Run the agent loop — Pi handles tool calls internally
    await conn.agent.prompt(userText);

    // Extract spoken text from the LAST assistant message only.
    // FOH agent should produce one short response per turn.
    const messages = conn.agent.state.messages;
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const spoken = lastAssistant ? extractText(lastAssistant) : '';
    send(conn.ws, { type: 'response', text: spoken });
    if (spoken) {
      console.log(`${tag} Response: "${spoken.substring(0, 80)}${spoken.length > 80 ? '...' : ''}"`);
    }
  } catch (err: any) {
    console.error(`${tag} Error:`, err.message);
    send(conn.ws, { type: 'error', message: err.message });
  } finally {
    conn.processing = false;
  }
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

let connectionCounter = 0;

function handleConnection(ws: WebSocket): void {
  const id = String(++connectionCounter);
  console.log(`[foh:${id}] Client connected`);

  // Create FOH (front-of-house) agent — fast conversational model
  const agent = new Agent({
    initialState: {
      model: FOH_MODEL,
      systemPrompt: buildFohSystemPrompt(),
    },
    getApiKey: async (provider) => resolveApiKey(provider),
  });

  const conn: Connection = { ws, id, agent, processing: false, workers: new Map(), workerCounter: 0 };

  // Set FOH tools (they need the connection reference for delegation)
  agent.setTools(buildFohTools(conn));

  // Subscribe to FOH agent events for logging
  agent.subscribe((e: AgentEvent) => {
    if (e.type === 'tool_execution_start') {
      console.log(`[foh:${id}] Tool: ${e.toolName}(${JSON.stringify(e.args).substring(0, 100)})`);
    }
  });

  // Send initial state + voice credentials
  send(ws, {
    type: 'init',
    todo: readTodo(),
    voiceCredentials: {
      deepgramApiKey: DEEPGRAM_API_KEY,
      elevenlabsApiKey: ELEVENLABS_API_KEY,
    },
  });

  ws.on('message', async (raw: Buffer | string) => {
    let msg: { type: string; text?: string };
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, { type: 'error', message: 'Invalid JSON' }); return; }

    if (msg.type === 'start') {
      await processStart(conn);
    } else if (msg.type === 'text' && msg.text?.trim()) {
      await processText(conn, msg.text.trim());
    }
  });

  ws.on('close', () => {
    // Abort all workers on disconnect
    for (const [, w] of conn.workers) w.abort();
    console.log(`[foh:${id}] Disconnected (${conn.workers.size} workers aborted)`);
  });
  ws.on('error', (err: Error) => console.error(`[foh:${id}] Error:`, err.message));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: WS_PORT });
const dummyConn = { ws: null as any, id: '0', agent: null as any, processing: false, workers: new Map(), workerCounter: 0 };
const toolNames = buildFohTools(dummyConn).map(t => t.name);
console.log(`Agent server (FOH/worker architecture) on ws://localhost:${WS_PORT}`);
console.log(`FOH model: ${FOH_MODEL.id} via OpenRouter (Groq-hosted)`);
console.log(`Worker models: research=${RESEARCH_MODEL.id}, shell/browser=${WORKER_MODEL.id}`);
console.log(`FOH tools: ${toolNames.join(', ')}`);
console.log(`Worker types: research (AgentRunner), shell (WorkerAgent), browser (WorkerAgent)`);

wss.on('connection', handleConnection);
wss.on('error', (err: Error) => console.error('[agent] Server error:', err.message));
