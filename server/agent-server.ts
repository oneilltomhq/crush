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
import { voiceTools, readTodo } from './pi-tools.js';
import { AgentRunner, type RunnerStatus } from './agent-runner.js';

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

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
if (!OPENROUTER_KEY) console.warn('[agent-server] OPENROUTER_API_KEY not set — research tool will fail');

function researchApiKey(provider: string): string {
  if (provider === 'openrouter') return OPENROUTER_KEY;
  return 'gateway';
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
// Model definition
// ---------------------------------------------------------------------------

const VOICE_MODEL: Model<'anthropic-messages'> = {
  id: 'claude-sonnet-4-20250514',
  name: 'Sonnet 4',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'http://169.254.169.254/gateway/llm/anthropic',
  reasoning: false,
  input: ['text'],
  cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 1024,
};

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const todo = readTodo();
  return `You are Crush — a voice-driven coding agent. You run on a Linux server with full system access. You are an experienced software engineer.

The user speaks to you and you speak back via TTS.

## Voice rules (critical)

- Keep responses SHORT — 1-3 sentences. This is a conversation, not a monologue.
- No markdown. No asterisks, bullets, or headers. Just talk like a person.
- Put structured content (code, lists, details) in a text pane instead of speaking it.
- Respond FAST. Say something first, then use tools if needed. Don't disappear into a tool chain.
- If a tool call will take time, say what you're doing first so the user isn't waiting in silence.
- Don't be fluffy. Be warm but direct, like a colleague.

## Tools

You have shell, read_file, write_file, web_search, browse, auth_browse, create_pane, and research tools. Use them when needed, but:
- For simple questions, just answer. Don't run a shell command to confirm things you already know.
- For complex investigations, tell the user you're looking into it, THEN use tools.
- For information lookup, use web_search first — it's fast and returns clean structured results.
- For browsing specific pages, use browse (server's Chromium) or auth_browse (user's authenticated browser).
- Only use auth_browse when you need the user's logged-in sessions (LinkedIn, X/Twitter, Gmail, etc.).
- Don't over-create panes. Keep the workspace clean.

## Workspace

The user sees a 3D grid of panes. You control what's in it:
- PTY panes: real bash shell sessions
- Browser panes: live browser tab with CDP screencast
- Text panes: scrollable text/markdown content
- Task panes: labeled organizational cards

Create panes when useful. Don't over-create. The workspace should stay clean.

## Project context

You are running inside the Crush project (/home/exedev/crush) — a Chrome extension + 3D spatial workspace. Key paths:
- src/ — client-side TypeScript (Three.js renderer, panes, voice client)
- server/ — server-side (this voice relay, agent runner, PTY relay)
- vendor/ — Ghostty WASM, ghostty-web
- adr/ — architecture decision records

You can read any of these files to answer questions about the system.

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
  agent: Agent;
  processing: boolean;
  runners: AgentRunner[];
}

// ---------------------------------------------------------------------------
// Build tools for a connection (includes research tools that need conn state)
// ---------------------------------------------------------------------------

function buildTools(conn: Connection): AgentTool[] {
  const tools = voiceTools(conn.ws);

  // research tool — launches a background AgentRunner
  const researchTool: AgentTool = {
    name: 'research',
    label: 'Research',
    description: `Launch a background research agent that autonomously browses the web, collects information, and builds a research document. Use when the user asks to research a topic or find information requiring multiple pages.`,
    parameters: Type.Object({
      goal: Type.String({ description: "What to research. Be specific — include the user's actual question, constraints, and desired output format." }),
    }),
    execute: async (_id, params) => {
      const goal = params.goal;
      const notesPaneLabel = `Research: ${goal.substring(0, 40)}${goal.length > 40 ? '...' : ''}`;

      send(conn.ws, {
        type: 'command', name: 'create_pane',
        input: { pane_type: 'text', label: notesPaneLabel, content: `# Researching...\n\n*${goal}*\n\nStarting research agent...` },
      });

      const runner = new AgentRunner({
        goal,
        ws: conn.ws,
        notesPaneLabel,
        model: RESEARCH_MODEL,
        // subModel defaults to model when not specified
        getApiKey: researchApiKey,
        onComplete: (summary) => {
          console.log(`[agent:${conn.id}] Research complete: ${summary.substring(0, 80)}`);
          send(conn.ws, { type: 'research_complete', runnerId: runner.id, summary });
        },
        onProgress: (status) => {
          console.log(`[agent:${conn.id}] Research progress: ${status}`);
        },
        onError: (err) => {
          console.error(`[agent:${conn.id}] Research error: ${err}`);
          send(conn.ws, { type: 'research_error', runnerId: runner.id, error: err });
        },
      });

      conn.runners.push(runner);
      runner.start();

      return {
        content: [{ type: 'text', text: `Research agent launched. It will browse the web and build findings in the "${notesPaneLabel}" pane. I'll keep working in the background — you can ask me how it's going anytime.` }],
        details: {},
      };
    },
  };

  // research_status tool
  const researchStatusTool: AgentTool = {
    name: 'research_status',
    label: 'Research Status',
    description: 'Check on running research agents. Use when the user asks how research is going.',
    parameters: Type.Object({}),
    execute: async () => {
      if (conn.runners.length === 0) {
        return { content: [{ type: 'text', text: 'No research agents running.' }], details: {} };
      }
      const statuses = conn.runners.map(r => {
        const s = r.getStatus();
        const subs = s.subQueries.map(sq => `  - ${sq.query.substring(0, 40)}: ${sq.state}`).join('\n');
        return `"${s.goal.substring(0, 50)}" — ${s.state}\n${subs}`;
      });
      return { content: [{ type: 'text', text: statuses.join('\n') }], details: {} };
    },
  };

  tools.push(researchTool, researchStatusTool);
  return tools;
}

// ---------------------------------------------------------------------------
// Process conversation start — agent speaks first
// ---------------------------------------------------------------------------

async function processStart(conn: Connection): Promise<void> {
  if (conn.processing) return;
  conn.processing = true;
  const tag = `[agent:${conn.id}]`;
  console.log(`${tag} Conversation started — agent speaks first`);

  try {
    send(conn.ws, { type: 'thinking' });

    const todo = readTodo();
    const hasTodo = todo && !todo.includes('No todo file found');
    const prompt = hasTodo
      ? '[System: The user just opened Crush and tapped to start. They have an existing todo list. Greet them briefly, mention how many items, and ask which one they want to tackle. One short sentence + one question. Warm, not cheesy.]'
      : '[System: The user just opened Crush for the first time. Say hi in ONE short sentence, then ask what they\'re working on today. That\'s it. Do NOT list features or capabilities. Do NOT mention shells, browsers, or tools. Just ask what they want to accomplish.]';

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
  const tag = `[agent:${conn.id}]`;
  console.log(`${tag} "${userText.substring(0, 80)}${userText.length > 80 ? '...' : ''}"`);

  try {
    send(conn.ws, { type: 'thinking' });

    // Trim context if too long (simple heuristic — keep last 30 messages)
    if (conn.agent.state.messages.length > 30) {
      const trimmed = conn.agent.state.messages.slice(-30);
      conn.agent.replaceMessages(trimmed);
    }

    // Run the agent loop — Pi handles tool calls internally
    await conn.agent.prompt(userText);

    // Collect all text from assistant messages produced during this prompt
    // (there may be multiple assistant messages if tools were called)
    const messages = conn.agent.state.messages;
    const spokenParts: string[] = [];
    // Walk backwards from end to find all assistant messages from this turn
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && typeof (m as any).content === 'string') break; // hit the user message
      if (m.role === 'user') continue; // skip tool_result user messages
      if (m.role === 'assistant') {
        const text = extractText(m);
        if (text) spokenParts.unshift(text);
      }
    }

    const spoken = spokenParts.join(' ').trim();
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
  console.log(`[agent:${id}] Client connected`);

  // Create Pi Agent for this connection
  const agent = new Agent({
    initialState: {
      model: VOICE_MODEL,
      systemPrompt: buildSystemPrompt(),
    },
    getApiKey: async () => 'not-needed',  // exe-gateway doesn't need API keys
  });

  const conn: Connection = { ws, id, agent, processing: false, runners: [] };

  // Set tools (they need the connection reference)
  agent.setTools(buildTools(conn));

  // Subscribe to agent events for logging
  agent.subscribe((e: AgentEvent) => {
    if (e.type === 'tool_execution_start') {
      console.log(`[agent:${id}] Tool: ${e.toolName}(${JSON.stringify(e.args).substring(0, 100)})`);
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

  ws.on('close', () => console.log(`[agent:${id}] Disconnected`));
  ws.on('error', (err: Error) => console.error(`[agent:${id}] Error:`, err.message));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: WS_PORT });
const toolNames = buildTools({ ws: null as any, id: '0', agent: null as any, processing: false, runners: [] }).map(t => t.name);
console.log(`Agent server (Pi agent-core) on ws://localhost:${WS_PORT}`);
console.log(`Model: ${VOICE_MODEL.id} via ${VOICE_MODEL.baseUrl}`);
console.log(`Tools: ${toolNames.join(', ')}`);

wss.on('connection', handleConnection);
wss.on('error', (err: Error) => console.error('[agent] Server error:', err.message));
