/**
 * Voice WebSocket Relay — port 8092
 *
 * Pure text LLM bridge. STT and TTS are client-side (ADR 005).
 *
 * Protocol (JSON text frames):
 *
 * Client → Server:
 *   { type: 'text', text: '...' }  — User utterance (from client-side STT or typed)
 *
 * Server → Client:
 *   { type: 'thinking' }           — LLM is processing
 *   { type: 'response', text }     — LLM response text (client handles TTS)
 *   { type: 'error', message }     — Error
 *
 * Usage:
 *   npx tsx server/voice-relay.ts [--port 8092]
 */

import { WebSocketServer, WebSocket } from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '8092');

const LLM_ENDPOINT = 'http://169.254.169.254/gateway/llm/anthropic/v1/messages';
const LLM_MODEL = 'claude-sonnet-4-20250514';
const LLM_MAX_TOKENS = 1024;

const TODO_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'todo.md');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClientMessage {
  type: 'text';
  text?: string;
}

interface ServerMessage {
  type: 'response' | 'thinking' | 'error';
  text?: string;
  message?: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Connection {
  ws: WebSocket;
  id: string;
  conversationHistory: ConversationMessage[];
  processing: boolean;
}

// ---------------------------------------------------------------------------
// Todo file helpers
// ---------------------------------------------------------------------------

function readTodoFile(): string {
  try {
    return fs.readFileSync(TODO_PATH, 'utf-8');
  } catch {
    return '(No todo file found)';
  }
}

function writeTodoFile(content: string): void {
  const dir = path.dirname(TODO_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TODO_PATH, content, 'utf-8');
  console.log('[voice] Updated todo file');
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const todo = readTodoFile();
  return `You are the voice assistant for Crush — a 3D spatial workspace built with Three.js/WebGPU. You help the user manage their workspace through natural conversation.

You're in conversational mode — after you speak, the mic automatically resumes listening. Keep responses SHORT and natural (1-3 sentences). No markdown, no bullet lists, no numbered lists — just talk like a person.

## The Workspace

Crush renders a spatial grid of panes in 3D. Each pane is a task node backed by a resource:
- **PTY panes**: real shell sessions on the server (bash via WebSocket)
- **Terminal panes**: local WASM terminals (Ghostty VT emulation)
- **Browser panes**: live browser tab streams via CDP screencast
- **Task panes**: labeled cards for organizing work

The pane system is a task graph — tasks can have children, forming a hierarchy. Users can "dive into" a parent task to see its subtasks as panes, and navigate back up with Escape.

Current keyboard shortcuts:
- P: create a PTY shell pane
- A: add a task pane
- B: add a browser pane
- S: split/decompose focused pane into subtasks
- X: complete and remove focused pane
- D: run demo sequence
- Click: focus a pane (zoom in)
- Click focused: dive into children (if any)
- Escape: zoom out / navigate up

You can issue commands to control the workspace by including a commands block at the END of your response:

<workspace_commands>
{"action": "create_task", "label": "Research API design"}
</workspace_commands>

Available actions:
- create_task: Create a labeled task pane. Fields: label (string), parentId? (string)
- create_pty: Create a PTY shell pane. Fields: label (string), command? (string — command to run in the shell)
- create_browser: Create a browser pane. Fields: label (string)
- complete_task: Complete and remove a task. Fields: taskId (string) OR label (string)

RULES for workspace commands:
- ONLY create panes when the user explicitly asks for them.
- NEVER create empty/idle shells. If you create a PTY, it must have a purpose (running a command, editing a file, etc.).
- NEVER speculatively create multiple panes "just in case." One pane per clear user intent.
- The todo list is already shown as a pane on startup — don't recreate it.
- Prefer doing less over doing more. The workspace should be clean and purposeful.
- Each line in the commands block is a separate JSON command.

## Current Workspace State

On startup, the workspace automatically creates:
- A Shell pane (PTY, already running bash)
- A Todo pane (showing the todo list below)

These already exist — don't recreate them.

## Todo List

You have access to the user's todo file:

---
${todo}
---

To update it, include at the END of your response (after any workspace_commands):

<todo_update>
(entire updated todo.md content)
</todo_update>

Today's date is ${new Date().toISOString().split('T')[0]}.`;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

async function callLLM(
  systemPrompt: string,
  messages: ConversationMessage[],
): Promise<string> {
  const response = await fetch(LLM_ENDPOINT, {
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
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM error ${response.status}: ${errText}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text?: string }>;
  };

  return data.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!)
    .join('\n');
}

interface ParsedResponse {
  spoken: string;
  todoContent: string | null;
  commands: Record<string, unknown>[];
}

function parseResponse(response: string): ParsedResponse {
  let text = response;
  let todoContent: string | null = null;
  const commands: Record<string, unknown>[] = [];

  // Extract todo update
  const todoMatch = text.match(/<todo_update>\s*([\s\S]*?)\s*<\/todo_update>/);
  if (todoMatch) {
    todoContent = todoMatch[1].trim();
    text = text.replace(/<todo_update>[\s\S]*?<\/todo_update>/, '');
  }

  // Extract workspace commands
  const cmdMatch = text.match(/<workspace_commands>\s*([\s\S]*?)\s*<\/workspace_commands>/);
  if (cmdMatch) {
    const lines = cmdMatch[1].trim().split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        commands.push(JSON.parse(trimmed));
      } catch (e) {
        console.error('[voice] Failed to parse command:', trimmed);
      }
    }
    text = text.replace(/<workspace_commands>[\s\S]*?<\/workspace_commands>/, '');
  }

  return { spoken: text.trim(), todoContent, commands };
}

// ---------------------------------------------------------------------------
// Send helper
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ---------------------------------------------------------------------------
// Process text through LLM
// ---------------------------------------------------------------------------

async function processText(conn: Connection, userText: string): Promise<void> {
  if (!userText.trim()) return;

  if (conn.processing) {
    send(conn.ws, { type: 'error', message: 'Still processing previous request' });
    return;
  }

  conn.processing = true;
  console.log(`[voice:${conn.id}] "${userText.substring(0, 80)}${userText.length > 80 ? '...' : ''}"`);

  try {
    conn.conversationHistory.push({ role: 'user', content: userText });
    if (conn.conversationHistory.length > 20) {
      conn.conversationHistory = conn.conversationHistory.slice(-20);
    }

    send(conn.ws, { type: 'thinking' });
    const rawResponse = await callLLM(buildSystemPrompt(), conn.conversationHistory);
    const { spoken, todoContent, commands } = parseResponse(rawResponse);

    if (todoContent) writeTodoFile(todoContent);

    conn.conversationHistory.push({ role: 'assistant', content: spoken });
    send(conn.ws, { type: 'response', text: spoken });
    console.log(`[voice:${conn.id}] Response: "${spoken.substring(0, 80)}${spoken.length > 80 ? '...' : ''}"`);

    // Forward workspace commands to client
    if (commands.length > 0) {
      console.log(`[voice:${conn.id}] Sending ${commands.length} workspace command(s)`);
      for (const cmd of commands) {
        send(conn.ws, { type: 'command' as any, ...cmd });
      }
    }
  } catch (err: any) {
    console.error(`[voice:${conn.id}] Error:`, err.message);
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
  console.log(`[voice:${id}] Client connected`);

  const conn: Connection = {
    ws,
    id,
    conversationHistory: [],
    processing: false,
  };

  // Send initial workspace state (todo content) on connect
  const todoContent = readTodoFile();
  send(ws, { type: 'init' as any, todo: todoContent });

  ws.on('message', async (raw: Buffer | string) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

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
console.log(`Voice relay (text-only LLM bridge) on ws://localhost:${WS_PORT}`);
console.log(`LLM: ${LLM_ENDPOINT}`);
console.log(`Todo: ${TODO_PATH}`);

wss.on('connection', handleConnection);
wss.on('error', (err: Error) => console.error('[voice] Server error:', err.message));
