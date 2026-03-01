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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');

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
    description: 'Scroll a text pane.',
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
    name: 'screenshot_pane',
    description: 'Take a screenshot of a browser pane to see what is currently displayed. Use this to read page content, verify navigation worked, or answer questions about what\'s on screen.',
    input_schema: {
      type: 'object' as const,
      properties: {
        label: { type: 'string', description: 'Label of the browser pane to screenshot' },
      },
      required: ['label'],
    },
  },
  {
    name: 'navigate_pane',
    description: 'Navigate a browser pane to a URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        label: { type: 'string', description: 'Label of the browser pane' },
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['label', 'url'],
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
}

// ---------------------------------------------------------------------------
// CDP screenshot — grab page screenshot directly from Chrome
// ---------------------------------------------------------------------------

import { WebSocket as WsClient } from 'ws';

async function cdpScreenshot(): Promise<string | null> {
  try {
    // Find active page tab
    const listRes = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
    const tabs: any[] = await listRes.json();
    const page = tabs.find((t: any) =>
      t.type === 'page' &&
      !t.url.startsWith('chrome://') &&
      !t.url.startsWith('chrome-extension://') &&
      !t.url.startsWith('devtools://')
    );
    if (!page?.webSocketDebuggerUrl) return null;

    // Connect to CDP and capture screenshot
    return await new Promise<string | null>((resolve) => {
      const ws = new WsClient(page.webSocketDebuggerUrl);
      const timeout = setTimeout(() => { ws.close(); resolve(null); }, 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Page.captureScreenshot',
          params: { format: 'jpeg', quality: 70 },
        }));
      });
      ws.on('message', (data: Buffer) => {
        clearTimeout(timeout);
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id === 1 && msg.result?.data) {
            resolve(msg.result.data); // base64 JPEG
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
        ws.close();
      });
      ws.on('error', () => { clearTimeout(timeout); resolve(null); });
    });
  } catch (e: any) {
    console.error('[voice] CDP screenshot error:', e.message);
    return null;
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

## Workspace

The workspace is a grid of panes:
- PTY panes: real bash shell sessions
- Browser panes: live browser tab with CDP screencast. Use screenshot_pane to see page content, navigate_pane to browse.
- Text panes: scrollable text/markdown content
- Task panes: labeled organizational cards

On startup, three panes exist: "Shell" (PTY), "Todo" (text), and "Transcript" (conversation log). Don't recreate these.

## Rules

- Only create panes when the user explicitly asks.
- Never create empty shells speculatively.
- One pane per clear user intent — don't over-create.
- The workspace should stay clean and purposeful.
- When browsing for the user, use screenshot_pane to see what's on the page, then describe what you see.

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
    case 'screenshot_pane': {
      // Grab screenshot directly from Chrome via CDP
      const b64 = await cdpScreenshot();
      if (!b64) return 'Failed to capture screenshot — no browser tab available.';
      console.log(`[voice] Screenshot captured (${Math.round(b64.length / 1024)}KB)`);
      return [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: b64 },
        },
        { type: 'text', text: 'Screenshot of the current browser tab.' },
      ];
    }
    case 'navigate_pane': {
      const label = String(input.label);
      const url = String(input.url);
      send(conn.ws, { type: 'command', name: 'navigate_pane', input: { label, url } });
      return `Navigated "${label}" to ${url}.`;
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

  const conn: Connection = { ws, id, history: [], processing: false };

  // Send initial state
  send(ws, { type: 'init', todo: readTodo() });

  ws.on('message', async (raw: Buffer | string) => {
    let msg: { type: string; text?: string };
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, { type: 'error', message: 'Invalid JSON' }); return; }

    if (msg.type === 'text' && msg.text?.trim()) {
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
