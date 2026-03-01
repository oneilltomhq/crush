/**
 * Voice WebSocket Relay — port 8092
 *
 * Full voice pipeline: STT (Deepgram) → LLM (Anthropic) → TTS (ElevenLabs)
 *
 * Protocol (JSON text frames):
 *
 * Client → Server:
 *   { type: 'voice_start' }                  — Begin capturing voice
 *   { type: 'audio', data: '<base64 PCM>' }   — PCM 16-bit LE, 16kHz, mono
 *   { type: 'voice_stop' }                    — End capture, trigger LLM
 *   { type: 'text', text: '...' }             — Text fallback (skip STT)
 *
 * Server → Client:
 *   { type: 'transcript', text, isFinal }     — STT result
 *   { type: 'thinking' }                      — LLM is processing
 *   { type: 'response', text }                — LLM response text
 *   { type: 'tts_start' }                     — TTS audio starting
 *   { type: 'audio', data: '<base64 mp3>' }   — TTS audio chunk
 *   { type: 'audio_end' }                     — TTS audio finished
 *   { type: 'error', message }                — Error
 *
 * Usage:
 *   npx tsx server/voice-relay.ts [--port 8092]
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createDeepgramStream, type DeepgramStream, type TranscriptEvent } from './deepgram.js';
import { textToSpeechStream, VOICES } from './elevenlabs.js';
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
  type: 'voice_start' | 'voice_stop' | 'audio' | 'text';
  data?: string;  // base64 PCM for 'audio'
  text?: string;  // text content for 'text'
}

interface ServerMessage {
  type: 'transcript' | 'response' | 'audio' | 'audio_end' | 'tts_start' | 'thinking' | 'error';
  text?: string;
  data?: string;
  isFinal?: boolean;
  message?: string;
}

interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface VoiceConnection {
  ws: WebSocket;
  id: string;
  conversationHistory: ConversationMessage[];
  deepgramStream: DeepgramStream | null;
  audioBuffer: Buffer[];  // buffered audio before Deepgram connects
  utteranceBuffer: string;
  processing: boolean;  // whether an LLM request is in flight
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

Examples of todo operations:
- "Add a task to set up CI/CD" → add a new checkbox item
- "Mark the ElevenLabs task as done" → change [ ] to [x]
- "Remove the Arc profile task" → delete that line
- "What's on my todo list?" → summarize the current tasks (no update block needed)

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

  const textBlocks = data.content
    .filter((b) => b.type === 'text' && b.text)
    .map((b) => b.text!);

  return textBlocks.join('\n');
}

/**
 * Extract <todo_update>...</todo_update> from the LLM response.
 * Returns { spoken, todoContent } where spoken has the block removed.
 */
function extractTodoUpdate(response: string): { spoken: string; todoContent: string | null } {
  const match = response.match(/<todo_update>\s*([\s\S]*?)\s*<\/todo_update>/);
  if (!match) {
    return { spoken: response.trim(), todoContent: null };
  }
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
// Voice pipeline: process an utterance through LLM + TTS
// ---------------------------------------------------------------------------

async function processUtterance(conn: VoiceConnection, userText: string): Promise<void> {
  if (!userText.trim()) {
    console.log(`[voice:${conn.id}] Empty utterance, skipping`);
    return;
  }

  if (conn.processing) {
    console.log(`[voice:${conn.id}] Already processing, queuing ignored`);
    send(conn.ws, { type: 'error', message: 'Still processing previous request' });
    return;
  }

  conn.processing = true;
  console.log(`[voice:${conn.id}] Processing: "${userText.substring(0, 80)}${userText.length > 80 ? '...' : ''}"`);

  try {
    // Add user message to history
    conn.conversationHistory.push({ role: 'user', content: userText });

    // Trim history to last 20 messages to keep context window manageable
    if (conn.conversationHistory.length > 20) {
      conn.conversationHistory = conn.conversationHistory.slice(-20);
    }

    // Call LLM
    send(conn.ws, { type: 'thinking' });
    const systemPrompt = buildSystemPrompt();
    const rawResponse = await callLLM(systemPrompt, conn.conversationHistory);

    // Extract todo updates
    const { spoken, todoContent } = extractTodoUpdate(rawResponse);

    if (todoContent) {
      writeTodoFile(todoContent);
    }

    // Add assistant response to history (full response for context, but user hears spoken)
    conn.conversationHistory.push({ role: 'assistant', content: spoken });

    // Send text response
    send(conn.ws, { type: 'response', text: spoken });
    console.log(`[voice:${conn.id}] Response: "${spoken.substring(0, 80)}${spoken.length > 80 ? '...' : ''}"`);

    // Stream TTS
    if (spoken) {
      await streamTTS(conn, spoken);
    }
  } catch (err: any) {
    console.error(`[voice:${conn.id}] Pipeline error:`, err.message);
    send(conn.ws, { type: 'error', message: err.message });
  } finally {
    conn.processing = false;
  }
}

// ---------------------------------------------------------------------------
// TTS streaming
// ---------------------------------------------------------------------------

async function streamTTS(conn: VoiceConnection, text: string): Promise<void> {
  send(conn.ws, { type: 'tts_start' });

  try {
    await textToSpeechStream(
      text,
      { voiceId: VOICES.charlie },
      (chunk: Buffer) => {
        send(conn.ws, { type: 'audio', data: chunk.toString('base64') });
      },
    );
    send(conn.ws, { type: 'audio_end' });
  } catch (err: any) {
    console.error(`[voice:${conn.id}] TTS error:`, err.message);
    send(conn.ws, { type: 'error', message: `TTS error: ${err.message}` });
  }
}

// ---------------------------------------------------------------------------
// Deepgram stream management
// ---------------------------------------------------------------------------

function startDeepgram(conn: VoiceConnection): void {
  // Clean up any existing stream
  if (conn.deepgramStream) {
    conn.deepgramStream.close();
    conn.deepgramStream = null;
  }

  conn.utteranceBuffer = '';
  conn.audioBuffer = [];

  const stream = createDeepgramStream();
  conn.deepgramStream = stream;

  stream.onTranscript = (event: TranscriptEvent) => {
    // Send transcript to client
    if (event.text) {
      send(conn.ws, {
        type: 'transcript',
        text: event.text,
        isFinal: event.isFinal,
      });
    }

    // Accumulate final transcripts
    if (event.isFinal && event.text) {
      conn.utteranceBuffer += (conn.utteranceBuffer ? ' ' : '') + event.text;
    }
  };

  stream.onOpen = () => {
    // Flush any buffered audio
    if (conn.audioBuffer.length > 0) {
      console.log(`[voice:${conn.id}] Flushing ${conn.audioBuffer.length} buffered audio chunks`);
      for (const chunk of conn.audioBuffer) {
        stream.sendAudio(chunk);
      }
      conn.audioBuffer = [];
    }
  };

  stream.onError = (err: Error) => {
    console.error(`[voice:${conn.id}] Deepgram error:`, err.message);
    send(conn.ws, { type: 'error', message: `STT error: ${err.message}` });
  };
}

/**
 * Stop Deepgram stream and wait for final transcripts to drain.
 * Returns the accumulated utterance text.
 */
async function stopDeepgram(conn: VoiceConnection): Promise<string> {
  const stream = conn.deepgramStream;
  if (!stream) return conn.utteranceBuffer.trim();

  conn.deepgramStream = null;
  conn.audioBuffer = [];

  return new Promise<string>((resolve) => {
    const timeout = setTimeout(() => {
      console.log(`[voice:${conn.id}] Deepgram drain timeout (3s)`);
      resolve(conn.utteranceBuffer.trim());
    }, 3000);

    const prevOnClose = stream.onClose;
    stream.onClose = () => {
      clearTimeout(timeout);
      prevOnClose?.();
      resolve(conn.utteranceBuffer.trim());
    };

    stream.close();
  });
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------

let connectionCounter = 0;

function handleConnection(ws: WebSocket): void {
  const id = String(++connectionCounter);
  console.log(`[voice:${id}] Client connected`);

  const conn: VoiceConnection = {
    ws,
    id,
    conversationHistory: [],
    deepgramStream: null,
    audioBuffer: [],
    utteranceBuffer: '',
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

    switch (msg.type) {
      case 'voice_start': {
        console.log(`[voice:${id}] voice_start`);
        startDeepgram(conn);
        break;
      }

      case 'audio': {
        if (!msg.data) break;
        const pcm = Buffer.from(msg.data, 'base64');
        if (conn.deepgramStream) {
          if (conn.deepgramStream.connected) {
            conn.deepgramStream.sendAudio(pcm);
          } else {
            conn.audioBuffer.push(pcm);
          }
        }
        break;
      }

      case 'voice_stop': {
        console.log(`[voice:${id}] voice_stop`);
        const utterance = await stopDeepgram(conn);
        console.log(`[voice:${id}] Final utterance: "${utterance}"`);
        if (utterance) {
          await processUtterance(conn, utterance);
        } else {
          send(ws, { type: 'error', message: 'No speech detected' });
        }
        break;
      }

      case 'text': {
        const text = msg.text?.trim();
        if (text) {
          console.log(`[voice:${id}] text input: "${text.substring(0, 60)}"`);
          await processUtterance(conn, text);
        }
        break;
      }

      default:
        send(ws, { type: 'error', message: `Unknown message type: ${(msg as any).type}` });
    }
  });

  ws.on('close', () => {
    console.log(`[voice:${id}] Client disconnected`);
    // Clean up Deepgram stream if still active
    if (conn.deepgramStream) {
      conn.deepgramStream.close();
      conn.deepgramStream = null;
    }
  });

  ws.on('error', (err: Error) => {
    console.error(`[voice:${id}] WebSocket error:`, err.message);
    if (conn.deepgramStream) {
      conn.deepgramStream.close();
      conn.deepgramStream = null;
    }
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: WS_PORT });
console.log(`Voice relay listening on ws://localhost:${WS_PORT}`);
console.log(`LLM endpoint: ${LLM_ENDPOINT}`);
console.log(`Todo file: ${TODO_PATH}`);

wss.on('connection', handleConnection);

wss.on('error', (err: Error) => {
  console.error('[voice] Server error:', err.message);
});
