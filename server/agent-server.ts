/**
 * Agent Server — port 8092
 *
 * Text-in/text-out LLM agent loop using Claude's native tool use.
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

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  return val;
}

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');
const AUTH_CDP_PORT = parseInt(process.env.AUTH_CDP_PORT || '9223');
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

// Voice credentials — server-side, sent to client in init
const DEEPGRAM_API_KEY = requireEnv('DEEPGRAM_API_KEY');
const ELEVENLABS_API_KEY = requireEnv('ELEVENLABS_API_KEY');

const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '8092');

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const LLM_MODEL = 'claude-sonnet-4-20250514';
const LLM_MAX_TOKENS = 1024;

const TODO_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'todo.md');

// ---------------------------------------------------------------------------
// Tool definitions — Claude JSON Schema
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'shell',
    description: `Run a shell command on the server and return its output. You have full access to the system — use it to inspect files, check processes, run builds, install packages, git operations, anything. The working directory is the Crush project root (/home/exedev/crush). Commands time out after 30 seconds.

Examples:
- ls -la src/
- cat server/agent-server.ts
- git log --oneline -10
- tmux capture-pane -t voice -p | tail -20
- ps aux | grep node
- npm run build`,
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file. More convenient than shell cat for reading code/config.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to the file (absolute or relative to /home/exedev/crush)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Path to write to' },
        content: { type: 'string', description: 'File content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'create_pane',
    description: 'Create a new pane in the workspace.',
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
    name: 'web_search',
    description: `Search the web using Tavily API. Returns structured, clean results with extracted content — much better than browser-based Google scraping. Use for any information lookup, fact-finding, or research query.

Returns an AI-generated answer plus up to 10 source results with extracted content. Use search_depth 'advanced' for thorough research, 'basic' for quick lookups.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query — be specific and include relevant context/constraints',
        },
        search_depth: {
          type: 'string',
          enum: ['basic', 'advanced'],
          description: 'basic = fast/cheap (3-5 results), advanced = thorough (5-10 results with deeper extraction). Default: basic.',
        },
        max_results: {
          type: 'number',
          description: 'Max results to return (1-10). Default: 5.',
        },
        include_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: limit search to these domains (e.g. ["linkedin.com", "crunchbase.com"])',
        },
        exclude_domains: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: exclude these domains from results',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'auth_browse',
    description: `Control the user's authenticated browser (their real Brave with logged-in sessions — LinkedIn, X/Twitter, Gmail, etc.). Connected via SSH tunnel on port ${AUTH_CDP_PORT}.

Same commands as browse, but runs against the user's actual browser with real auth cookies. Use for:
- Viewing LinkedIn profiles, connections, and job posts
- Reading X/Twitter feeds and threads
- Accessing any site the user is logged into

Do NOT use for general research — use web_search or browse instead. Only use auth_browse when you specifically need the user's authenticated session.

Common commands: open <url>, snapshot -i, click @<ref>, get text <selector>, screenshot`,
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'agent-browser command (same syntax as browse tool)',
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

// CDP WebSocket URL cache per port
const cdpWsUrls: Map<number, string> = new Map();

async function getCdpWsUrl(port: number = CDP_PORT): Promise<string> {
  const cached = cdpWsUrls.get(port);
  if (cached) return cached;
  const res = await fetch(`http://${CDP_HOST}:${port}/json/version`);
  const data: any = await res.json();
  const wsUrl = data.webSocketDebuggerUrl;
  cdpWsUrls.set(port, wsUrl);
  return wsUrl;
}

async function runAgentBrowser(args: string[], port: number = CDP_PORT): Promise<string> {
  const wsUrl = await getCdpWsUrl(port);
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
// Tavily web search
// ---------------------------------------------------------------------------

interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  answer?: string;
  results: TavilyResult[];
}

async function tavilySearch(opts: {
  query: string;
  search_depth?: 'basic' | 'advanced';
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
}): Promise<string> {
  if (!TAVILY_API_KEY) return 'Error: TAVILY_API_KEY not configured';

  const body: Record<string, unknown> = {
    api_key: TAVILY_API_KEY,
    query: opts.query,
    search_depth: opts.search_depth || 'basic',
    max_results: opts.max_results || 5,
    include_answer: true,
  };
  if (opts.include_domains?.length) body.include_domains = opts.include_domains;
  if (opts.exclude_domains?.length) body.exclude_domains = opts.exclude_domains;

  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    return `Tavily error ${res.status}: ${errText}`;
  }

  const data = await res.json() as TavilyResponse;

  // Format into a clean, LLM-friendly text block
  const parts: string[] = [];
  if (data.answer) {
    parts.push(`**Answer:** ${data.answer}`);
    parts.push('');
  }
  parts.push(`**Sources (${data.results.length}):**`);
  for (const r of data.results) {
    parts.push(`\n### ${r.title}`);
    parts.push(`URL: ${r.url}`);
    parts.push(r.content);
  }
  return parts.join('\n');
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
  console.log('[agent] Updated todo file');
}

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
      ...(ANTHROPIC_API_KEY ? { 'x-api-key': ANTHROPIC_API_KEY } : {}),
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
    case 'shell': {
      const command = String(input.command);
      console.log(`[agent:${conn.id}] shell: ${command.substring(0, 100)}`);
      try {
        const { stdout, stderr } = await execFileAsync(
          'bash', ['-c', command],
          { timeout: 30000, maxBuffer: 2 * 1024 * 1024, cwd: '/home/exedev/crush' },
        );
        const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
        const maxLen = 12000;
        return output.length > maxLen
          ? output.substring(0, maxLen) + `\n... (truncated, ${output.length - maxLen} chars omitted)`
          : output || '(no output)';
      } catch (e: any) {
        const output = ((e.stdout || '') + (e.stderr || '')).trim();
        return output || `Error (exit ${e.code}): ${e.message}`;
      }
    }
    case 'read_file': {
      const filePath = String(input.path);
      const absPath = path.isAbsolute(filePath) ? filePath : path.join('/home/exedev/crush', filePath);
      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        const maxLen = 12000;
        return content.length > maxLen
          ? content.substring(0, maxLen) + `\n... (truncated, ${content.length - maxLen} chars omitted)`
          : content;
      } catch (e: any) {
        return `Error reading ${absPath}: ${e.message}`;
      }
    }
    case 'write_file': {
      const filePath = String(input.path);
      const content = String(input.content);
      const absPath = path.isAbsolute(filePath) ? filePath : path.join('/home/exedev/crush', filePath);
      try {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, content, 'utf-8');
        return `Wrote ${content.length} bytes to ${absPath}`;
      } catch (e: any) {
        return `Error writing ${absPath}: ${e.message}`;
      }
    }
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
    case 'browse':
    case 'auth_browse': {
      const command = String(input.command || '');
      const args = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
      const cleanArgs = args.map(a => a.replace(/^["']|["']$/g, ''));
      const port = name === 'auth_browse' ? AUTH_CDP_PORT : CDP_PORT;
      const label = name === 'auth_browse' ? 'auth_browse' : 'browse';
      console.log(`[agent] ${label}:${port}: ${cleanArgs.join(' ')}`);

      // If it's an 'open' command, also tell the client to update the browser pane
      if (cleanArgs[0] === 'open' && cleanArgs[1]) {
        send(conn.ws, { type: 'command', name: 'navigate_pane', input: { label: '', url: cleanArgs[1] } });
      }

      try {
        const output = await runAgentBrowser(cleanArgs, port);
        const maxLen = 8000;
        const truncated = output.length > maxLen
          ? output.substring(0, maxLen) + `\n... (truncated, ${output.length - maxLen} chars omitted)`
          : output;
        return truncated;
      } catch (e: any) {
        if (name === 'auth_browse') {
          return `Error: Could not connect to authenticated browser on port ${AUTH_CDP_PORT}. Is the SSH tunnel running? (ssh -NR ${AUTH_CDP_PORT}:localhost:9222 valley-silver.exe.xyz)`;
        }
        throw e;
      }
    }
    case 'web_search': {
      const query = String(input.query);
      console.log(`[agent:${conn.id}] web_search: "${query.substring(0, 80)}"`);
      const result = await tavilySearch({
        query,
        search_depth: (input.search_depth as 'basic' | 'advanced') || 'basic',
        max_results: (input.max_results as number) || 5,
        include_domains: input.include_domains as string[] | undefined,
        exclude_domains: input.exclude_domains as string[] | undefined,
      });
      const maxLen = 10000;
      return result.length > maxLen
        ? result.substring(0, maxLen) + `\n... (truncated)`
        : result;
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
          console.log(`[agent:${conn.id}] Research complete: ${summary.substring(0, 80)}`);
          // Notify user via a response if they're not mid-conversation
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

      return `Research agent launched. It will browse the web and build findings in the "${notesPaneLabel}" pane. I'll keep working in the background — you can ask me how it's going anytime.`;
    }
    case 'research_status': {
      if (conn.runners.length === 0) {
        return 'No research agents running.';
      }
      const statuses = conn.runners.map(r => {
        const s = r.getStatus();
        const subs = s.subQueries.map(sq => `  - ${sq.query.substring(0, 40)}: ${sq.state}`).join('\n');
        return `"${s.goal.substring(0, 50)}" — ${s.state}\n${subs}`;
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
      console.warn(`[agent] Unknown tool: ${name}`);
      return `Unknown tool: ${name}`;
  }
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
  const tag = `[agent:${conn.id}]`;
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
    const MAX_ITERATIONS = 8;  // safety limit — keep voice responsive

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
  console.log(`[agent:${id}] Client connected`);

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

  ws.on('close', () => console.log(`[agent:${id}] Disconnected`));
  ws.on('error', (err: Error) => console.error(`[agent:${id}] Error:`, err.message));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: WS_PORT });
console.log(`Agent server (LLM tool-use loop) on ws://localhost:${WS_PORT}`);
console.log(`LLM: ${LLM_ENDPOINT}`);
console.log(`Todo: ${TODO_PATH}`);
console.log(`Tools: ${TOOLS.map(t => t.name).join(', ')}`);

wss.on('connection', handleConnection);
wss.on('error', (err: Error) => console.error('[agent] Server error:', err.message));
