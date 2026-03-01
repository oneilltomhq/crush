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
  return `You are a conversational voice assistant for the crush workspace — a 3D desktop environment built with Three.js and WebGL. You help the user manage tasks, brainstorm, and control their workspace.

Keep your responses concise and natural — this is a voice conversation, not a text chat. Aim for 1-3 sentences unless the user asks for something detailed. Don't use markdown formatting, bullet points, or numbered lists in your speech — just talk naturally.

You have access to the user's todo list. Here is the current content:

---
${todo}
---

When the user asks you to update, add, remove, or modify tasks on their todo list, respond with the updated content wrapped in a special block:

<todo_update>
(entire updated todo.md content here)
</todo_update>

Include this block at the END of your response, after your spoken reply. The block will be parsed and the file updated automatically — the user won't see the raw block.

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

function extractTodoUpdate(response: string): { spoken: string; todoContent: string | null } {
  const match = response.match(/<todo_update>\s*([\s\S]*?)\s*<\/todo_update>/);
  if (!match) return { spoken: response.trim(), todoContent: null };
  const todoContent = match[1].trim();
  const spoken = response.replace(/<todo_update>[\s\S]*?<\/todo_update>/, '').trim();
  return { spoken, todoContent };
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
    const { spoken, todoContent } = extractTodoUpdate(rawResponse);

    if (todoContent) writeTodoFile(todoContent);

    conn.conversationHistory.push({ role: 'assistant', content: spoken });
    send(conn.ws, { type: 'response', text: spoken });
    console.log(`[voice:${conn.id}] Response: "${spoken.substring(0, 80)}${spoken.length > 80 ? '...' : ''}"`);
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
