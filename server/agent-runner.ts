/**
 * AgentRunner — autonomous background agent for multi-step tasks.
 *
 * Spawned by the voice relay when the user requests research or other
 * long-running work. Runs its own LLM conversation loop with a high
 * iteration limit, creates/updates panes via the same WebSocket command
 * protocol, and streams progress back to the UI.
 *
 * See ADR 007.
 */

import { WebSocket } from 'ws';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LLM_ENDPOINT = 'http://169.254.169.254/gateway/llm/anthropic/v1/messages';
const LLM_MODEL = 'claude-sonnet-4-20250514';
const LLM_MAX_TOKENS = 4096;
const MAX_ITERATIONS = 50;
const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');

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

export interface AgentRunnerOpts {
  /** The research goal / user request */
  goal: string;
  /** WebSocket to send pane commands back to the client */
  ws: WebSocket;
  /** Label of the notes pane to update with findings */
  notesPaneLabel: string;
  /** Callback when runner completes */
  onComplete?: (summary: string) => void;
  /** Callback on progress (for voice agent to optionally narrate) */
  onProgress?: (status: string) => void;
  /** Callback on error */
  onError?: (err: string) => void;
}

export interface RunnerStatus {
  id: string;
  goal: string;
  state: 'running' | 'complete' | 'error';
  iterations: number;
  maxIterations: number;
  currentActivity: string;
  paneCount: number;
}

// ---------------------------------------------------------------------------
// Runner tools — focused on research workflow
// ---------------------------------------------------------------------------

const RUNNER_TOOLS = [
  {
    name: 'browse',
    description: `Browse the web. Commands:
- open <url>: Navigate to a URL
- snapshot: Full page content (text + structure)
- snapshot -i: Interactive elements only (links, buttons) with @refs
- click @<ref>: Click an element
- type @<ref> <text>: Type into an input
- scroll down/up: Scroll the page
- get text @<ref>: Get text of an element

Workflow: open URL → snapshot to read → click links to explore → extract info.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'agent-browser command, e.g. "open https://example.com" or "snapshot" or "click @e3"',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'open_browser_pane',
    description: 'Open a new browser pane in the workspace to show a URL to the user. Use for key pages you want the user to see.',
    input_schema: {
      type: 'object' as const,
      properties: {
        label: { type: 'string', description: 'Display label for the pane' },
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['label', 'url'],
    },
  },
  {
    name: 'update_notes',
    description: 'Update the research notes pane with current findings. Call this frequently as you discover information — the user can see it updating in real time. Use markdown formatting.',
    input_schema: {
      type: 'object' as const,
      properties: {
        content: { type: 'string', description: 'Complete updated notes content (replaces previous)' },
      },
      required: ['content'],
    },
  },
  {
    name: 'log_progress',
    description: 'Send a short status update to the user about what you\'re doing. 1 sentence. Use when starting a new sub-task or making a significant finding.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Short progress message' },
      },
      required: ['message'],
    },
  },
];

// ---------------------------------------------------------------------------
// CDP / agent-browser
// ---------------------------------------------------------------------------

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
      { timeout: 30000, maxBuffer: 2 * 1024 * 1024 },
    );
    return (stdout + (stderr ? `\n${stderr}` : '')).trim();
  } catch (e: any) {
    const output = (e.stdout || '') + (e.stderr || '');
    return output.trim() || `Error: ${e.message}`;
  }
}

// ---------------------------------------------------------------------------
// LLM call
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
      tools: RUNNER_TOOLS,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LLM ${res.status}: ${errText}`);
  }

  return res.json() as Promise<ApiResponse>;
}

// ---------------------------------------------------------------------------
// WebSocket helpers
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

let runnerCounter = 0;

export class AgentRunner {
  readonly id: string;
  private goal: string;
  private ws: WebSocket;
  private notesPaneLabel: string;
  private history: ConversationMessage[] = [];
  private state: 'running' | 'complete' | 'error' = 'running';
  private iterations = 0;
  private currentActivity = 'starting';
  private createdPanes: string[] = [];
  private onComplete?: (summary: string) => void;
  private onProgress?: (status: string) => void;
  private onError?: (err: string) => void;
  private aborted = false;

  constructor(opts: AgentRunnerOpts) {
    this.id = `runner-${++runnerCounter}`;
    this.goal = opts.goal;
    this.ws = opts.ws;
    this.notesPaneLabel = opts.notesPaneLabel;
    this.onComplete = opts.onComplete;
    this.onProgress = opts.onProgress;
    this.onError = opts.onError;
  }

  /** Start the autonomous research loop. Non-blocking — runs in background. */
  start(): void {
    this.run().catch(err => {
      this.state = 'error';
      console.error(`[${this.id}] Fatal error:`, err.message);
      this.onError?.(err.message);
    });
  }

  /** Abort the runner. It will stop after the current iteration. */
  abort(): void {
    this.aborted = true;
    console.log(`[${this.id}] Abort requested`);
  }

  getStatus(): RunnerStatus {
    return {
      id: this.id,
      goal: this.goal,
      state: this.state,
      iterations: this.iterations,
      maxIterations: MAX_ITERATIONS,
      currentActivity: this.currentActivity,
      paneCount: this.createdPanes.length,
    };
  }

  private buildSystemPrompt(): string {
    return `You are a research agent inside Crush, a spatial workspace. You have been given a research goal and must work autonomously to fulfill it.

Your job: browse the web, collect information, and build a comprehensive research document in the notes pane.

## Research methodology

1. Break the goal into 3-5 specific sub-queries
2. For each sub-query: open relevant pages, read content (use snapshot), extract key facts
3. Update the notes pane FREQUENTLY with findings as you go — the user can see it in real time
4. Open browser panes for the most important/useful pages so the user can see them
5. When done, write a final summary at the top of the notes

## Rules

- Work through sub-queries systematically — don't jump around
- Use log_progress to tell the user what you're doing ("Searching for AI companies in Shoreditch...")
- Update notes after every meaningful finding — don't wait until the end
- Open at most 4-5 browser panes total (the best/most useful pages)
- When browsing search results, click through to actual pages to get real info — don't just read Google snippets
- Use snapshot (not snapshot -i) when you want to READ page content
- Use snapshot -i when you need to find clickable elements
- Be thorough but efficient — you have ${MAX_ITERATIONS} iterations total
- When you have enough information, write a final summary and stop (respond with text, no more tool calls)

## Notes format

Use markdown. Structure with headers for each sub-topic. Include:
- Company/org names with brief descriptions
- URLs for key resources
- Key people/contacts when available
- Your assessment/recommendations

Today is ${new Date().toISOString().split('T')[0]}.`;
  }

  private async executeTool(
    name: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const tag = `[${this.id}]`;

    switch (name) {
      case 'browse': {
        const command = String(input.command || '');
        const args = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
        const cleanArgs = args.map(a => a.replace(/^["']|["']$/g, ''));
        this.currentActivity = `browsing: ${cleanArgs.join(' ').substring(0, 60)}`;
        console.log(`${tag} browse: ${cleanArgs.join(' ')}`);

        // Update the last browser pane if it's an 'open' command
        if (cleanArgs[0] === 'open' && cleanArgs[1]) {
          send(this.ws, { type: 'command', name: 'navigate_pane', input: { label: '', url: cleanArgs[1] } });
        }

        const output = await runAgentBrowser(cleanArgs);
        const maxLen = 8000;
        return output.length > maxLen
          ? output.substring(0, maxLen) + `\n... (truncated, ${output.length - maxLen} chars omitted)`
          : output;
      }

      case 'open_browser_pane': {
        const label = String(input.label);
        const url = String(input.url);
        send(this.ws, {
          type: 'command', name: 'create_pane',
          input: { pane_type: 'browser', label, url },
        });
        this.createdPanes.push(label);
        console.log(`${tag} opened browser pane: "${label}" → ${url}`);
        return `Opened browser pane "${label}" showing ${url}.`;
      }

      case 'update_notes': {
        const content = String(input.content);
        // Update the text pane content
        send(this.ws, {
          type: 'command', name: 'update_text_pane',
          input: { label: this.notesPaneLabel, content },
        });
        console.log(`${tag} updated notes (${content.length} chars)`);
        return 'Notes updated.';
      }

      case 'log_progress': {
        const message = String(input.message);
        this.currentActivity = message;
        console.log(`${tag} progress: ${message}`);
        this.onProgress?.(message);
        // Also send as a visual status to the client
        send(this.ws, {
          type: 'research_progress',
          runnerId: this.id,
          message,
        });
        return 'Logged.';
      }

      default:
        return `Unknown tool: ${name}`;
    }
  }

  private async run(): Promise<void> {
    const tag = `[${this.id}]`;
    console.log(`${tag} Starting research: "${this.goal}"`);

    const systemPrompt = this.buildSystemPrompt();

    // Seed with the research goal
    this.history.push({
      role: 'user',
      content: `Research goal: ${this.goal}\n\nBegin your research. Start by breaking this into sub-queries, then work through them systematically. Update the notes pane as you go.`,
    });

    while (this.iterations < MAX_ITERATIONS && !this.aborted) {
      this.iterations++;
      console.log(`${tag} Iteration ${this.iterations}/${MAX_ITERATIONS}`);

      let response: ApiResponse;
      try {
        response = await callLLM(systemPrompt, this.history);
      } catch (err: any) {
        console.error(`${tag} LLM error at iteration ${this.iterations}:`, err.message);
        // Retry once after a short delay
        await new Promise(r => setTimeout(r, 2000));
        try {
          response = await callLLM(systemPrompt, this.history);
        } catch (err2: any) {
          this.state = 'error';
          this.onError?.(`LLM error: ${err2.message}`);
          return;
        }
      }

      // Store assistant response
      this.history.push({ role: 'assistant', content: response.content });

      // If no tool use, research is done
      if (response.stop_reason !== 'tool_use') {
        const finalText = response.content
          .filter((b: ContentBlock) => b.type === 'text' && b.text)
          .map((b: ContentBlock) => b.text)
          .join(' ')
          .trim();

        this.state = 'complete';
        this.currentActivity = 'done';
        console.log(`${tag} Complete after ${this.iterations} iterations`);
        this.onComplete?.(finalText || 'Research complete.');
        return;
      }

      // Execute tool calls
      const toolResults: ContentBlock[] = [];
      for (const block of response.content) {
        if (block.type === 'tool_use' && block.id && block.name && block.input) {
          console.log(`${tag} Tool: ${block.name}(${JSON.stringify(block.input).substring(0, 100)})`);
          const result = await this.executeTool(block.name, block.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          } as any);
        }
      }

      this.history.push({ role: 'user', content: toolResults });

      // Trim history if it gets too long (keep first message + recent)
      if (this.history.length > 60) {
        const first = this.history[0];
        this.history = [first, ...this.history.slice(-40)];
        console.log(`${tag} Trimmed history to ${this.history.length} messages`);
      }
    }

    if (this.aborted) {
      this.state = 'complete';
      this.currentActivity = 'aborted by user';
      console.log(`${tag} Aborted after ${this.iterations} iterations`);
      this.onComplete?.('Research was stopped.');
    } else {
      // Hit iteration limit
      this.state = 'complete';
      this.currentActivity = 'done (hit iteration limit)';
      console.log(`${tag} Hit iteration limit (${MAX_ITERATIONS})`);
      this.onComplete?.('Research complete (reached iteration limit).');
    }
  }
}
