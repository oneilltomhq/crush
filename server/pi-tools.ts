/**
 * pi-tools.ts — Tool definitions for the Crush agent.
 *
 * Each tool is a self-contained AgentTool object: name, description,
 * TypeBox parameter schema, and execute() function. No switch/case dispatch.
 *
 * Tools are grouped into sets for different agent roles:
 *  - voiceTools: full set for the interactive voice agent
 *  - researchTools: subset for research sub-runners (web_search + browse only)
 */

import { Type } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { AgentTool, AgentToolResult } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { WebSocket } from 'ws';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------

const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');
const AUTH_CDP_PORT = parseInt(process.env.AUTH_CDP_PORT || '9223');
function getTavilyKey(): string { return process.env.TAVILY_API_KEY || ''; }
const TODO_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'todo.md');
const PROJECT_ROOT = '/home/exedev/crush';
const PROFILE_DIR = path.join(os.homedir(), '.crush', 'profile');
const DOWNLOADS_DIR = path.join(os.homedir(), '.crush', 'downloads');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Expand leading ~ to the user's home directory. */
function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function textResult(text: string): AgentToolResult<any> {
  return { content: [{ type: 'text', text }], details: {} };
}

function truncate(text: string, maxLen: number): string {
  return text.length > maxLen
    ? text.substring(0, maxLen) + `\n... (truncated, ${text.length - maxLen} chars omitted)`
    : text;
}

// CDP WebSocket URL cache
const cdpWsUrls = new Map<number, string>();

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
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
    );
    return (stdout + (stderr ? `\n${stderr}` : '')).trim();
  } catch (e: any) {
    const output = (e.stdout || '') + (e.stderr || '');
    return output.trim() || `Error: ${e.message}`;
  }
}

function parseBrowserArgs(command: string): string[] {
  const args = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return args.map(a => a.replace(/^["']|["']$/g, ''));
}

export async function tavilySearch(opts: {
  query: string;
  search_depth?: 'basic' | 'advanced';
  max_results?: number;
  include_domains?: string[];
  exclude_domains?: string[];
}): Promise<string> {
  const tavilyKey = getTavilyKey();
  if (!tavilyKey) return 'Error: TAVILY_API_KEY not configured';

  const body: Record<string, unknown> = {
    api_key: tavilyKey,
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

  const data: any = await res.json();
  const parts: string[] = [];
  if (data.answer) {
    parts.push(`**Answer:** ${data.answer}`);
    parts.push('');
  }
  parts.push(`**Sources (${(data.results || []).length}):**`);
  for (const r of data.results || []) {
    parts.push(`\n### ${r.title}`);
    parts.push(`URL: ${r.url}`);
    parts.push(r.content);
  }
  return parts.join('\n');
}

export function readTodo(): string {
  try { return fs.readFileSync(TODO_PATH, 'utf-8'); }
  catch { return '(No todo file found)'; }
}

/** Read all files from ~/.crush/profile/ and return concatenated content */
export function readProfile(): string {
  try {
    if (!fs.existsSync(PROFILE_DIR)) return '';
    const files = fs.readdirSync(PROFILE_DIR).filter(f => f.endsWith('.md')).sort();
    if (files.length === 0) return '';
    return files.map(f => {
      const content = fs.readFileSync(path.join(PROFILE_DIR, f), 'utf-8');
      return `## ${f}\n\n${content}`;
    }).join('\n\n---\n\n');
  } catch { return ''; }
}

function writeTodo(content: string): void {
  fs.mkdirSync(path.dirname(TODO_PATH), { recursive: true });
  fs.writeFileSync(TODO_PATH, content, 'utf-8');
  console.log('[agent] Updated todo file');
}

// ---------------------------------------------------------------------------
// WebSocket send helper (shared by tools that push commands to client)
// ---------------------------------------------------------------------------

export type WsSend = (msg: Record<string, unknown>) => void;

function wsSend(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// Tool factories — tools that need a WebSocket are created per-connection
// ---------------------------------------------------------------------------

/** Shell command execution */
export function makeShellTool(): AgentTool {
  return {
    name: 'shell',
    label: 'Shell',
    description: `Run a shell command on the server and return its output. You have full access to the system — use it to inspect files, check processes, run builds, install packages, git operations, anything. The working directory is the Crush project root (${PROJECT_ROOT}). Commands time out after 30 seconds.`,
    parameters: Type.Object({
      command: Type.String({ description: 'The bash command to execute' }),
    }),
    execute: async (_id, params) => {
      console.log(`[tool] shell: ${String(params.command).substring(0, 100)}`);
      try {
        const { stdout, stderr } = await execFileAsync(
          'bash', ['-c', params.command],
          { timeout: 30000, maxBuffer: 2 * 1024 * 1024, cwd: PROJECT_ROOT },
        );
        const output = (stdout + (stderr ? `\nSTDERR: ${stderr}` : '')).trim();
        return textResult(truncate(output || '(no output)', 12000));
      } catch (e: any) {
        const output = ((e.stdout || '') + (e.stderr || '')).trim();
        return textResult(output || `Error (exit ${e.code}): ${e.message}`);
      }
    },
  };
}

/** Read file */
export function makeReadFileTool(): AgentTool {
  return {
    name: 'read_file',
    label: 'Read File',
    description: 'Read the contents of a file. More convenient than shell cat for reading code/config.',
    parameters: Type.Object({
      path: Type.String({ description: `Path to the file (absolute or relative to ${PROJECT_ROOT})` }),
    }),
    execute: async (_id, params) => {
      const expanded = expandTilde(params.path);
      const absPath = path.isAbsolute(expanded) ? expanded : path.join(PROJECT_ROOT, expanded);
      try {
        const content = fs.readFileSync(absPath, 'utf-8');
        return textResult(truncate(content, 12000));
      } catch (e: any) {
        return textResult(`Error reading ${absPath}: ${e.message}`);
      }
    },
  };
}

/** Write file */
export function makeWriteFileTool(): AgentTool {
  return {
    name: 'write_file',
    label: 'Write File',
    description: 'Write content to a file. Creates parent directories if needed.',
    parameters: Type.Object({
      path: Type.String({ description: 'Path to write to' }),
      content: Type.String({ description: 'File content' }),
    }),
    execute: async (_id, params) => {
      const expanded = expandTilde(params.path);
      const absPath = path.isAbsolute(expanded) ? expanded : path.join(PROJECT_ROOT, expanded);
      try {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.writeFileSync(absPath, params.content, 'utf-8');
        return textResult(`Wrote ${params.content.length} bytes to ${absPath}`);
      } catch (e: any) {
        return textResult(`Error writing ${absPath}: ${e.message}`);
      }
    },
  };
}

/** Create workspace pane */
export function makeCreatePaneTool(ws: WebSocket): AgentTool {
  return {
    name: 'create_pane',
    label: 'Create Pane',
    description: 'Create a new pane in the workspace.',
    parameters: Type.Object({
      pane_type: Type.Union([
        Type.Literal('pty'), Type.Literal('browser'),
        Type.Literal('text'), Type.Literal('task'),
      ], { description: 'pty = real shell session, browser = live browser tab, text = static content display, task = labeled card' }),
      label: Type.String({ description: 'Display label for the pane' }),
      command: Type.Optional(Type.String({ description: 'For pty panes only: initial command' })),
      url: Type.Optional(Type.String({ description: 'For browser panes only: URL to navigate to' })),
      content: Type.Optional(Type.String({ description: 'For text panes only: text content' })),
    }),
    execute: async (_id, params) => {
      wsSend(ws, { type: 'command', name: 'create_pane', input: params });
      return textResult(`Created ${params.pane_type} pane "${params.label}".`);
    },
  };
}

/** Remove workspace pane */
export function makeRemovePaneTool(ws: WebSocket): AgentTool {
  return {
    name: 'remove_pane',
    label: 'Remove Pane',
    description: 'Remove a pane from the workspace.',
    parameters: Type.Object({
      label: Type.String({ description: 'Label of the pane to remove (partial match OK)' }),
    }),
    execute: async (_id, params) => {
      wsSend(ws, { type: 'command', name: 'remove_pane', input: { label: params.label } });
      return textResult(`Removed pane "${params.label}".`);
    },
  };
}

/** Scroll text pane */
export function makeScrollPaneTool(ws: WebSocket): AgentTool {
  return {
    name: 'scroll_pane',
    label: 'Scroll Pane',
    description: 'Scroll a text pane up or down.',
    parameters: Type.Object({
      label: Type.String({ description: 'Label of the text pane to scroll' }),
      direction: Type.Union([Type.Literal('up'), Type.Literal('down')]),
      amount: Type.Optional(Type.Union([
        Type.Literal('small'), Type.Literal('medium'), Type.Literal('large'),
        Type.Literal('top'), Type.Literal('bottom'),
      ], { description: 'How far to scroll. Default: medium' })),
    }),
    execute: async (_id, params) => {
      wsSend(ws, { type: 'command', name: 'scroll_pane', input: params });
      return textResult(`Scrolled "${params.label}" ${params.direction} (${params.amount || 'medium'}).`);
    },
  };
}

/** Browse — headless server Chromium */
export function makeBrowseTool(ws: WebSocket): AgentTool {
  return {
    name: 'browse',
    label: 'Browse',
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
    parameters: Type.Object({
      command: Type.String({ description: 'agent-browser command and arguments' }),
    }),
    execute: async (_id, params) => {
      const args = parseBrowserArgs(params.command);
      console.log(`[tool] browse: ${args.join(' ')}`);
      if (args[0] === 'open' && args[1]) {
        wsSend(ws, { type: 'command', name: 'navigate_pane', input: { label: '', url: args[1] } });
      }
      const output = await runAgentBrowser(args, CDP_PORT);
      return textResult(truncate(output, 8000));
    },
  };
}

/** Auth browse — user's real authenticated browser */
export function makeAuthBrowseTool(ws: WebSocket): AgentTool {
  return {
    name: 'auth_browse',
    label: 'Auth Browse',
    description: `Control the user's authenticated browser (their real Brave with logged-in sessions). Use for accessing sites the user is logged into (LinkedIn, X/Twitter, Gmail, etc.). Do NOT use for general research — use web_search or browse instead.`,
    parameters: Type.Object({
      command: Type.String({ description: 'agent-browser command (same syntax as browse tool)' }),
    }),
    execute: async (_id, params) => {
      const args = parseBrowserArgs(params.command);
      console.log(`[tool] auth_browse: ${args.join(' ')}`);
      if (args[0] === 'open' && args[1]) {
        wsSend(ws, { type: 'command', name: 'navigate_pane', input: { label: '', url: args[1] } });
      }
      try {
        const output = await runAgentBrowser(args, AUTH_CDP_PORT);
        return textResult(truncate(output, 8000));
      } catch (e: any) {
        return textResult(`Error: Could not connect to authenticated browser on port ${AUTH_CDP_PORT}. Is the SSH tunnel running?`);
      }
    },
  };
}

/** Web search via Tavily */
export function makeWebSearchTool(): AgentTool {
  return {
    name: 'web_search',
    label: 'Web Search',
    description: `Search the web using Tavily API. Returns structured, clean results with extracted content — much better than browser-based Google scraping. Use for any information lookup, fact-finding, or research query.`,
    parameters: Type.Object({
      query: Type.String({ description: 'Search query — be specific and include relevant context/constraints' }),
      search_depth: Type.Optional(Type.Union([
        Type.Literal('basic'), Type.Literal('advanced'),
      ], { description: 'basic = fast (3-5 results), advanced = thorough (5-10 results). Default: basic.' })),
      max_results: Type.Optional(Type.Number({ description: 'Max results to return (1-10). Default: 5.' })),
      include_domains: Type.Optional(Type.Array(Type.String(), { description: 'Limit search to these domains' })),
      exclude_domains: Type.Optional(Type.Array(Type.String(), { description: 'Exclude these domains from results' })),
    }),
    execute: async (_id, params) => {
      console.log(`[tool] web_search: "${String(params.query).substring(0, 80)}"`);
      const result = await tavilySearch({
        query: params.query,
        search_depth: params.search_depth,
        max_results: params.max_results,
        include_domains: params.include_domains,
        exclude_domains: params.exclude_domains,
      });
      return textResult(truncate(result, 10000));
    },
  };
}

/** Download a file from a URL */
export function makeDownloadTool(): AgentTool {
  return {
    name: 'download',
    label: 'Download',
    description: `Download a file from a URL. Saves to ~/.crush/downloads/ by default. Returns the local path. Use for fetching documents, images, data files, etc. For web page content, prefer browse or web_search instead.`,
    parameters: Type.Object({
      url: Type.String({ description: 'URL to download' }),
      filename: Type.Optional(Type.String({ description: 'Save as this filename (default: derived from URL)' })),
    }),
    execute: async (_id, params) => {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
      const urlObj = new URL(params.url);
      const defaultName = path.basename(urlObj.pathname) || 'download';
      const filename = params.filename || defaultName;
      const outPath = path.join(DOWNLOADS_DIR, filename);
      console.log(`[tool] download: ${params.url} → ${outPath}`);
      try {
        const res = await fetch(params.url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Crush/1.0)' },
          redirect: 'follow',
        });
        if (!res.ok) return textResult(`Download failed: HTTP ${res.status} ${res.statusText}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(outPath, buffer);
        const sizeMB = (buffer.length / (1024 * 1024)).toFixed(2);
        return textResult(`Downloaded ${sizeMB} MB to ${outPath}`);
      } catch (e: any) {
        return textResult(`Download error: ${e.message}`);
      }
    },
  };
}

/** Update todo list */
export function makeUpdateTodoTool(ws: WebSocket): AgentTool {
  return {
    name: 'update_todo',
    label: 'Update Todo',
    description: 'Replace the todo list with updated content.',
    parameters: Type.Object({
      content: Type.String({ description: 'Complete updated todo.md content (replaces entire file)' }),
    }),
    execute: async (_id, params) => {
      writeTodo(params.content);
      wsSend(ws, { type: 'command', name: 'update_todo', input: { content: params.content } });
      return textResult('Todo list updated.');
    },
  };
}

// ---------------------------------------------------------------------------
// Standalone browse tool for research sub-runners (no WebSocket needed)
// ---------------------------------------------------------------------------

export function makeStandaloneBrowseTool(): AgentTool {
  return {
    name: 'browse',
    label: 'Browse',
    description: `Visit a specific URL and extract its content. Use only when web_search results reference a page you need to read in full.
Commands: open <url>, get text body, snapshot -i, click @<ref>, scroll down`,
    parameters: Type.Object({
      command: Type.String({ description: 'agent-browser command' }),
    }),
    execute: async (_id, params) => {
      const args = parseBrowserArgs(params.command);
      console.log(`[tool] browse: ${args.join(' ')}`);
      const output = await runAgentBrowser(args, CDP_PORT);
      return textResult(truncate(output, 8000));
    },
  };
}

// ---------------------------------------------------------------------------
// Tool sets
// ---------------------------------------------------------------------------

/** Tools for the FOH (front-of-house) voice agent — instant ops only */
export function fohTools(ws: WebSocket): AgentTool[] {
  return [
    makeReadFileTool(),
    makeWriteFileTool(),
    makeCreatePaneTool(ws),
    makeRemovePaneTool(ws),
    makeScrollPaneTool(ws),
    makeUpdateTodoTool(ws),
    // delegate_task, check_tasks, abort_task added in agent-server.ts
    // because they need access to the worker registry
  ];
}

/** Tools for shell/coding workers */
export function shellWorkerTools(): AgentTool[] {
  return [
    makeShellTool(),
    makeReadFileTool(),
    makeWriteFileTool(),
    makeWebSearchTool(),
    makeDownloadTool(),
  ];
}

/** Tools for browser automation workers */
export function browserWorkerTools(ws: WebSocket): AgentTool[] {
  return [
    makeBrowseTool(ws),
    makeAuthBrowseTool(ws),
    makeWebSearchTool(),
    makeReadFileTool(),
    makeWriteFileTool(),
  ];
}

/** Tools for research sub-runners (no WebSocket dependency) */
export function researchSubTools(): AgentTool[] {
  return [
    makeWebSearchTool(),
    makeStandaloneBrowseTool(),
  ];
}

/** All tools for legacy single-agent mode (requires WebSocket) */
export function voiceTools(ws: WebSocket): AgentTool[] {
  return [
    makeShellTool(),
    makeReadFileTool(),
    makeWriteFileTool(),
    makeCreatePaneTool(ws),
    makeRemovePaneTool(ws),
    makeScrollPaneTool(ws),
    makeBrowseTool(ws),
    makeAuthBrowseTool(ws),
    makeWebSearchTool(),
    makeDownloadTool(),
    makeUpdateTodoTool(ws),
  ];
}
