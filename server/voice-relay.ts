/**
 * Voice WebSocket Relay — port 8092
 *
 * Text-only LLM bridge using Claude's native tool use.
 * STT and TTS are client-side (ADR 005).
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
import fs from 'fs';
import path from 'path';
import os from 'os';
import { AgentRunner, type RunnerStatus } from './agent-runner';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');

// Voice credentials — server-side, sent to client in init
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || 'REDACTED_DEEPGRAM_KEY';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || 'REDACTED_ELEVENLABS_KEY';

const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '8092');

const LLM_ENDPOINT = 'http://169.254.169.254/gateway/llm/anthropic/v1/messages';
const LLM_MODEL = 'claude-sonnet-4-20250514';
const LLM_MAX_TOKENS = 1024;

const TODO_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'todo.md');

// ---------------------------------------------------------------------------
// Tool definitions — Claude JSON Schema
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'create_pane',
    description: 'Create a new pane in the workspace. Only when the user explicitly requests it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pane_type: {
          type: 'string',
          enum: ['pty', 'browser', 'text', 'task'],
          description: 'pty = real shell session, browser = live browser tab, text = static content display, task = labeled card',
        },
        label: { type: 'string', description: 'Display label for the pane' },
        command: { type: 'string', description: 'For pty panes only: initial command to run in the shell' },
        url: { type: 'string', description: 'For browser panes only: URL to navigate to' },
        content: { type: 'string', description: 'For text panes only: text content to display' },
      },
      required: ['pane_type', 'label'],
    },
  },
  {
    name: 'remove_pane',
    description: 'Remove a pane from the workspace.',
    input_schema: {
      type: 'object' as const,
      properties: {
        label: { type: 'string', description: 'Label of the pane to remove (partial match OK)' },
      },
      required: ['label'],
    },
  },
  {
    name: 'scroll_pane',
    description: 'Scroll a text pane up or down. Use when the user wants to see more content, read further, or go back to the top. You can call this multiple times to keep scrolling.',
    input_schema: {
      type: 'object' as const,
      properties: {
        label: { type: 'string', description: 'Label of the text pane to scroll' },
        direction: { type: 'string', enum: ['up', 'down'] },
        amount: {
          type: 'string',
          enum: ['small', 'medium', 'large', 'top', 'bottom'],
          description: 'How far to scroll. small ~3 lines, medium ~half page, large ~full page, top/bottom = jump to start/end',
        },
      },
      required: ['label', 'direction'],
    },
  },
  {
    name: 'browse',
    description: `Control the browser tab shown in browser panes. Powered by agent-browser CLI.

Common commands:
- open <url>: Navigate to a URL
- snapshot: Full accessibility tree (page structure + text content)
- snapshot -i: Interactive elements only (links, buttons, inputs) with refs
- click @<ref>: Click an element by ref from snapshot
- type @<ref> <text>: Type into an input
- fill @<ref> <text>: Clear and fill an input
- scroll down/up [px]: Scroll the page
- press Enter/Tab/Escape: Press a key
- get text @<ref>: Get text content of an element
- screenshot: Take a screenshot (returns image)

Workflow: open URL → snapshot -i to see interactive elements → click/type using @refs → snapshot again to see result.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'agent-browser command and arguments, e.g. "open https://example.com" or "snapshot -i" or "click @e3"',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'research',
    description: `Launch a background research agent that autonomously browses the web, collects information, and builds a research document. Use when the user asks to research a topic, investigate something, or find information that requires visiting multiple pages.

The researcher works in the background — you stay responsive to the user. It creates a notes pane and optionally browser panes showing key pages.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        goal: {
          type: 'string',
          description: 'What to research. Be specific — include the user\'s actual question/interest, any constraints, and what kind of output they want.',
        },
      },
      required: ['goal'],
    },
  },
  {
    name: 'research_status',
    description: 'Check on running research agents. Use when the user asks how research is going.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'update_todo',
    description: 'Replace the todo list with updated content. Use when the user asks to add, remove, or modify todo items.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Complete updated todo.md content (replaces entire file)' },
      },
      required: ['content'],
    },
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ApiResponse {
  content: ContentBlock[];
  stop_reason: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

interface Connection {
  ws: WebSocket;
  id: string;
  history: ConversationMessage[];
  processing: boolean;
  runners: AgentRunner[];
}

// ---------------------------------------------------------------------------
// agent-browser — structured browser automation via CLI
// ---------------------------------------------------------------------------

import { execFile } from 'child_process';
import { promisify } from 'util';
const execFileAsync = promisify(execFile);

let cdpWsUrl: string | null = null;

async function getCdpWsUrl(): Promise<string> {
  if (cdpWsUrl) return cdpWsUrl;
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/version`);
  const data: any = await res.json();
  cdpWsUrl = data.webSocketDebuggerUrl;
  return cdpWsUrl!;
}

async function runAgentBrowser(args: string[]): Promise<string> {
  const wsUrl = await getCdpWsUrl();
  try {
    const { stdout, stderr } = await execFileAsync(
      'agent-browser', ['--cdp', wsUrl, ...args],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    return (stdout + (stderr ? `\n${stderr}` : '')).trim();
  } catch (e: any) {
    const output = (e.stdout || '') + (e.stderr || '');
    return output.trim() || `Error: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// Todo file
// ---------------------------------------------------------------------------

function readTodo(): string {
  try { return fs.readFileSync(TODO_PATH, 'utf-8'); }
  catch { return '(No todo file found)'; }
}

function writeTodo(content: string): void {
  fs.mkdirSync(path.dirname(TODO_PATH), { recursive: true });
  fs.writeFileSync(TODO_PATH, content, 'utf-8');
  console.log('[voice] Updated todo file');
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const todo = readTodo();
  return `You are the voice assistant for Crush, a spatial workspace rendered in 3D. The user talks to you; you talk back and manage their workspace using tools.

Keep responses SHORT — 1-3 sentences, conversational. No markdown, no bullet lists. Talk like a person.

Focus on OUTCOMES, not tools. Never say "I can open a shell" or "I can browse the web" — instead, just DO the thing the user needs. If they say "I need to fix a bug in my server", open a shell and start looking. If they mention a URL, open it. Act on intent, don't narrate your capabilities.

## Workspace

The workspace is a grid of panes:
- PTY panes: real bash shell sessions
- Browser panes: live browser tab with CDP screencast. Use the browse tool to interact with the page.
- Text panes: scrollable text/markdown content
- Task panes: labeled organizational cards

The workspace starts empty. Create panes only when the user asks or when it's clearly useful (e.g. user asks to work on code → open a shell).

## Rules

- Only create panes when the user explicitly asks.
- Never create empty shells speculatively.
- One pane per clear user intent — don't over-create.
- The workspace should stay clean and purposeful.
- When browsing, use browse tool: "open <url>" to navigate, "snapshot -i" to see interactive elements, "click @ref" to interact, "snapshot" for full page content. Always snapshot after navigating to see what loaded.
- For research tasks (finding information, investigating topics, comparing options), use the research tool — it launches a background agent that does thorough multi-page research autonomously. Don't try to research by hand with browse — delegate to the researcher.
- You can check on research with research_status.

## Todo list

Current contents:

${todo}

Today is ${new Date().toISOString().split('T')[0]}.`;
}

// ---------------------------------------------------------------------------
// LLM call with tool use loop
// ---------------------------------------------------------------------------

async function callLLM(
  systemPrompt: string,
  messages: ConversationMessage[],
): Promise<ApiResponse> {
  const res = await fetch(LLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      max_tokens: LLM_MAX_TOKENS,
      system: systemPrompt,
      messages,
      tools: TOOLS,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM ${res.status}: ${errText}`);
  }

  return res.json() as Promise<ApiResponse>;
}

/** Execute a tool call. Returns content for the tool_result message. */
async function executeTool(
  name: string,
  input: Record<string, unknown>,
  conn: Connection,
): Promise<string | any[]> {
  switch (name) {
    case 'create_pane': {
      const paneType = String(input.pane_type);
      const label = String(input.label);
      send(conn.ws, { type: 'command', name: 'create_pane', input: { pane_type: paneType, label, command: input.command, url: input.url, content: input.content } });
      return `Created ${paneType} pane "${label}".`;
    }
    case 'remove_pane': {
      const label = String(input.label);
      send(conn.ws, { type: 'command', name: 'remove_pane', input: { label } });
      return `Removed pane "${label}".`;
    }
    case 'scroll_pane': {
      const label = String(input.label);
      const direction = String(input.direction);
      const amount = String(input.amount || 'medium');
      send(conn.ws, { type: 'command', name: 'scroll_pane', input: { label, direction, amount } });
      return `Scrolled "${label}" ${direction} (${amount}).`;
    }
    case 'browse': {
      const command = String(input.command || '');
      const args = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      // Strip quotes from args
      const cleanArgs = args.map(a => a.replace(/^["']|["']$/g, ''));
      console.log(`[voice] browse: ${cleanArgs.join(' ')}`);

      // If it's an 'open' command, also tell the client to update the browser pane
      if (cleanArgs[0] === 'open' && cleanArgs[1]) {
        send(conn.ws, { type: 'command', name: 'navigate_pane', input: { label: '', url: cleanArgs[1] } });
      }

      const output = await runAgentBrowser(cleanArgs);
      // Truncate very long output to avoid blowing context
      const maxLen = 8000;
      const truncated = output.length > maxLen
        ? output.substring(0, maxLen) + `\n... (truncated, ${output.length - maxLen} chars omitted)`
        : output;
      return truncated;
    }
    case 'research': {
      const goal = String(input.goal);
      const notesPaneLabel = `Research: ${goal.substring(0, 40)}${goal.length > 40 ? '...' : ''}`;

      // Create the notes pane first
      send(conn.ws, {
        type: 'command', name: 'create_pane',
        input: { pane_type: 'text', label: notesPaneLabel, content: `# Researching...\n\n*${goal}*\n\nStarting research agent...` },
      });

      const runner = new AgentRunner({
        goal,
        ws: conn.ws,
        notesPaneLabel,
        onComplete: (summary) => {
          console.log(`[voice:${conn.id}] Research complete: ${summary.substring(0, 80)}`);
          // Notify user via a response if they're not mid-conversation
          send(conn.ws, { type: 'research_complete', runnerId: runner.id, summary });
        },
        onProgress: (status) => {
          console.log(`[voice:${conn.id}] Research progress: ${status}`);
        },
        onError: (err) => {
          console.error(`[voice:${conn.id}] Research error: ${err}`);
          send(conn.ws, { type: 'research_error', runnerId: runner.id, error: err });
        },
      });

      conn.runners.push(runner);
      runner.start();

      return `Research agent launched. It will browse the web and build findings in the "${notesPaneLabel}" pane. I'll keep working in the background — you can ask me how it's going anytime.`;
    }
    case 'research_status': {
      if (conn.runners.length === 0) {
        return 'No research agents running.';
      }
      const statuses = conn.runners.map(r => {
        const s = r.getStatus();
        return `"${s.goal.substring(0, 50)}" — ${s.state}, ${s.iterations}/${s.maxIterations} iterations, ${s.currentActivity}`;
      });
      return statuses.join('\n');
    }
    case 'update_todo': {
      const content = String(input.content);
      writeTodo(content);
      // Also tell the client to refresh the todo pane
      send(conn.ws, { type: 'command', name: 'update_todo', input: { content } });
      return 'Todo list updated.';
    }
    default:
      console.warn(`[voice] Unknown tool: ${name}`);
      return `Unknown tool: ${name}`;
  }
}

// ---------------------------------------------------------------------------
// Process conversation start — agent speaks first
// ---------------------------------------------------------------------------

async function processStart(conn: Connection): Promise<void> {
  if (conn.processing) return;
  conn.processing = true;
  const tag = `[voice:${conn.id}]`;
  console.log(`${tag} Conversation started — agent speaks first`);

  try {
    send(conn.ws, { type: 'thinking' });
    const systemPrompt = buildSystemPrompt();

    // Seed with an instruction to introduce yourself
    const todo = readTodo();
    const hasTodo = todo && !todo.includes('No todo file found');
    const prompt = hasTodo
      ? '[System: The user just opened Crush and tapped to start. They have an existing todo list. Greet them briefly, mention how many items, and ask which one they want to tackle. One short sentence + one question. Warm, not cheesy.]'
      : '[System: The user just opened Crush for the first time. Say hi in ONE short sentence, then ask what they\'re working on today. That\'s it. Do NOT list features or capabilities. Do NOT mention shells, browsers, or tools. Just ask what they want to accomplish. Example tone: "Hey, I\'m Crush. What are you working on?" End with a question they can answer in one breath.]';
    conn.history.push({ role: 'user', content: prompt });

    const response = await callLLM(systemPrompt, conn.history);
    conn.history.push({ role: 'assistant', content: response.content });

    const spoken = response.content
      .filter((b: ContentBlock) => b.type === 'text' && b.text)
      .map((b: ContentBlock) => b.text)
      .join(' ')
      .trim();

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
// Process user text — full tool use loop
// ---------------------------------------------------------------------------

async function processText(conn: Connection, userText: string): Promise<void> {
  if (!userText.trim()) return;
  if (conn.processing) {
    send(conn.ws, { type: 'error', message: 'Still processing previous request' });
    return;
  }

  conn.processing = true;
  const tag = `[voice:${conn.id}]`;
  console.log(`${tag} "${userText.substring(0, 80)}${userText.length > 80 ? '...' : ''}"`);

  try {
    // Add user message
    conn.history.push({ role: 'user', content: userText });
    if (conn.history.length > 30) conn.history = conn.history.slice(-30);

    send(conn.ws, { type: 'thinking' });
    const systemPrompt = buildSystemPrompt();

    // Tool use loop: keep calling until stop_reason is 'end_turn'
    let spokenParts: string[] = [];
    let iterations = 0;
    const MAX_ITERATIONS = 5;  // safety limit

    while (iterations < MAX_ITERATIONS) {
      iterations++;
      const response = await callLLM(systemPrompt, conn.history);

      // Collect text blocks for TTS
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          spokenParts.push(block.text);
        }
      }

      // Store full assistant response in history (preserves tool_use blocks)
      conn.history.push({ role: 'assistant', content: response.content });

      // If no tool use, we're done
      if (response.stop_reason !== 'tool_use') break;

      // Execute tool calls and build tool_result message
      const toolResults: ContentBlock[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use' && block.id && block.name && block.input) {
          console.log(`${tag} Tool: ${block.name}(${JSON.stringify(block.input)})`);
          const result = await executeTool(block.name, block.input, conn);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result, // string or array of content blocks
          } as any);
        }
      }

      // Send tool results back as a user message (Anthropic API format)
      conn.history.push({ role: 'user', content: toolResults });
    }

    // Send spoken response to client
    const spoken = spokenParts.join(' ').trim();
    if (spoken) {
      send(conn.ws, { type: 'response', text: spoken });
      console.log(`${tag} Response: "${spoken.substring(0, 80)}${spoken.length > 80 ? '...' : ''}"`);
    } else {
      // Tool-only response with no speech — send empty response so client resumes listening
      send(conn.ws, { type: 'response', text: '' });
    }

  } catch (err: any) {
    console.error(`${tag} Error:`, err.message);
    send(conn.ws, { type: 'error', message: err.message });
  } finally {
    conn.processing = false;
  }
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

let connectionCounter = 0;

function handleConnection(ws: WebSocket): void {
  const id = String(++connectionCounter);
  console.log(`[voice:${id}] Client connected`);

  const conn: Connection = { ws, id, history: [], processing: false, runners: [] };

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
      // Agent speaks first — generate an opening line
      await processStart(conn);
    } else if (msg.type === 'text' && msg.text?.trim()) {
      await processText(conn, msg.text.trim());
    }
  });

  ws.on('close', () => console.log(`[voice:${id}] Disconnected`));
  ws.on('error', (err: Error) => console.error(`[voice:${id}] Error:`, err.message));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: WS_PORT });
console.log(`Voice relay (tool-use LLM bridge) on ws://localhost:${WS_PORT}`);
console.log(`LLM: ${LLM_ENDPOINT}`);
console.log(`Todo: ${TODO_PATH}`);
console.log(`Tools: ${TOOLS.map(t => t.name).join(', ')}`);

wss.on('connection', handleConnection);
wss.on('error', (err: Error) => console.error('[voice] Server error:', err.message));
