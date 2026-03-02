/**
 * AgentRunner — autonomous background agent for multi-step tasks.
 *
 * Two-phase design:
 *   1. PLAN — LLM decomposes the goal into 3-6 parallel sub-queries
 *   2. EXECUTE — sub-queries run as parallel SubRunners, each with its own
 *      LLM conversation + browser session. All run concurrently.
 *   3. SYNTHESIZE — parent runner collects all findings and writes final report.
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

const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const LLM_MODEL = 'claude-sonnet-4-20250514';
const LLM_MAX_TOKENS = 4096;
const SUB_RUNNER_MAX_ITERATIONS = 10;  // per sub-query (reduced — Tavily is faster than browsing)
const CDP_HOST = process.env.CDP_HOST || 'localhost';
const CDP_PORT = parseInt(process.env.CDP_PORT || '9222');
const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';

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
  goal: string;
  ws: WebSocket;
  notesPaneLabel: string;
  onComplete?: (summary: string) => void;
  onProgress?: (status: string) => void;
  onError?: (err: string) => void;
}

export interface RunnerStatus {
  id: string;
  goal: string;
  state: 'planning' | 'researching' | 'synthesizing' | 'complete' | 'error';
  subQueries: { query: string; state: string; iterations: number }[];
}

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
// Tavily web search
// ---------------------------------------------------------------------------

async function tavilySearch(query: string, maxResults: number = 5, depth: 'basic' | 'advanced' = 'basic'): Promise<string> {
  if (!TAVILY_API_KEY) return 'Error: TAVILY_API_KEY not configured';
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: TAVILY_API_KEY,
      query,
      search_depth: depth,
      max_results: maxResults,
      include_answer: true,
    }),
  });
  if (!res.ok) return `Tavily error ${res.status}: ${await res.text()}`;
  const data: any = await res.json();
  const parts: string[] = [];
  if (data.answer) parts.push(`Answer: ${data.answer}\n`);
  for (const r of data.results || []) {
    parts.push(`### ${r.title}\nURL: ${r.url}\n${r.content}\n`);
  }
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

async function callLLM(
  systemPrompt: string,
  messages: ConversationMessage[],
  tools?: any[],
  maxTokens?: number,
): Promise<ApiResponse> {
  const body: any = {
    model: LLM_MODEL,
    max_tokens: maxTokens || LLM_MAX_TOKENS,
    system: systemPrompt,
    messages,
  };
  if (tools && tools.length > 0) body.tools = tools;

  const res = await fetch(LLM_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...(ANTHROPIC_API_KEY ? { 'x-api-key': ANTHROPIC_API_KEY } : {}),
    },
    body: JSON.stringify(body),
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
// SubRunner — handles one sub-query with its own LLM conversation
// ---------------------------------------------------------------------------

const SUB_RUNNER_TOOLS = [
  {
    name: 'web_search',
    description: `Search the web. Returns an AI answer plus structured source results with extracted content. This is your PRIMARY research tool — use it first, use browse only if you need to visit a specific page for deeper extraction.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query — be specific' },
        max_results: { type: 'number', description: 'Results to return (1-10, default 5)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'browse',
    description: `Visit a specific URL and extract its content. Use only when web_search results reference a page you need to read in full.
Commands: open <url>, get text body, snapshot -i, click @<ref>, scroll down`,
    input_schema: {
      type: 'object' as const,
      properties: {
        command: { type: 'string', description: 'agent-browser command' },
      },
      required: ['command'],
    },
  },
];

interface SubRunnerResult {
  query: string;
  findings: string;
  keyUrls: { title: string; url: string }[];
}

async function runSubQuery(
  query: string,
  index: number,
  ws: WebSocket,
  parentId: string,
  onProgress: (msg: string) => void,
): Promise<SubRunnerResult> {
  const tag = `[${parentId}:sub${index}]`;
  console.log(`${tag} Starting: "${query}"`);
  onProgress(`Sub-query ${index + 1}: ${query}`);

  const systemPrompt = `You are a focused research sub-agent. You have ONE specific query to research.

Rules:
- Start with web_search — it returns clean, structured results instantly
- Only use browse if you need to read a specific page in more depth
- Stay focused on your specific query — don't go off-topic
- Extract concrete facts: names, numbers, dates, URLs
- 1-3 tool calls should be enough. Don't over-search.
- Your final response (when you stop using tools) should be a structured summary in markdown
- Include source URLs

Today is ${new Date().toISOString().split('T')[0]}.`;

  const history: ConversationMessage[] = [{
    role: 'user',
    content: `Research this specific query: ${query}\n\nUse web_search first, then browse specific pages if needed. Report back with structured findings.`,
  }];

  let iterations = 0;
  const keyUrls: { title: string; url: string }[] = [];

  while (iterations < SUB_RUNNER_MAX_ITERATIONS) {
    iterations++;
    console.log(`${tag} Iteration ${iterations}/${SUB_RUNNER_MAX_ITERATIONS}`);

    let response: ApiResponse;
    try {
      response = await callLLM(systemPrompt, history, SUB_RUNNER_TOOLS);
    } catch (err: any) {
      console.error(`${tag} LLM error:`, err.message);
      return { query, findings: `Error researching: ${err.message}`, keyUrls };
    }

    history.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      // Done — extract findings
      const findings = response.content
        .filter((b: ContentBlock) => b.type === 'text' && b.text)
        .map((b: ContentBlock) => b.text)
        .join('\n')
        .trim();
      console.log(`${tag} Complete after ${iterations} iterations (${findings.length} chars)`);
      return { query, findings, keyUrls };
    }

    // Execute tool calls
    const toolResults: ContentBlock[] = [];
    for (const block of response.content) {
      if (block.type === 'tool_use' && block.id && block.name && block.input) {
        let output: string;

        if (block.name === 'web_search') {
          const searchQuery = String(block.input.query || '');
          const maxResults = (block.input.max_results as number) || 5;
          console.log(`${tag} web_search: "${searchQuery}"`);
          output = await tavilySearch(searchQuery, maxResults);
          // Extract URLs from results for tracking
          const urlMatches = output.matchAll(/URL: (https?:\/\/\S+)/g);
          for (const m of urlMatches) {
            keyUrls.push({ title: searchQuery.substring(0, 40), url: m[1] });
          }
        } else {
          // browse
          const command = String(block.input.command || '');
          const args = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
          const cleanArgs = args.map(a => a.replace(/^["']|["']$/g, ''));
          console.log(`${tag} browse: ${cleanArgs.join(' ')}`);
          if (cleanArgs[0] === 'open' && cleanArgs[1]) {
            keyUrls.push({ title: query, url: cleanArgs[1] });
          }
          output = await runAgentBrowser(cleanArgs);
        }

        const maxLen = 8000;
        const truncated = output.length > maxLen
          ? output.substring(0, maxLen) + `\n... (truncated)`
          : output;

        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: truncated,
        } as any);
      }
    }

    history.push({ role: 'user', content: toolResults });
  }

  // Hit iteration limit — return what we have
  return { query, findings: 'Reached iteration limit without completing.', keyUrls };
}

// ---------------------------------------------------------------------------
// AgentRunner — orchestrates plan → parallel execute → synthesize
// ---------------------------------------------------------------------------

let runnerCounter = 0;

export class AgentRunner {
  readonly id: string;
  private goal: string;
  private ws: WebSocket;
  private notesPaneLabel: string;
  private state: RunnerStatus['state'] = 'planning';
  private subQueryStates: { query: string; state: string; iterations: number }[] = [];
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

  start(): void {
    this.run().catch(err => {
      this.state = 'error';
      console.error(`[${this.id}] Fatal error:`, err.message);
      this.onError?.(err.message);
    });
  }

  abort(): void {
    this.aborted = true;
    console.log(`[${this.id}] Abort requested`);
  }

  getStatus(): RunnerStatus {
    return {
      id: this.id,
      goal: this.goal,
      state: this.state,
      subQueries: [...this.subQueryStates],
    };
  }

  private updateNotes(content: string): void {
    send(this.ws, {
      type: 'command', name: 'update_text_pane',
      input: { label: this.notesPaneLabel, content },
    });
  }

  private progress(msg: string): void {
    console.log(`[${this.id}] ${msg}`);
    this.onProgress?.(msg);
    send(this.ws, { type: 'research_progress', runnerId: this.id, message: msg });
  }

  private async run(): Promise<void> {
    const tag = `[${this.id}]`;
    console.log(`${tag} Starting research: "${this.goal}"`);

    // ------------------------------------------------------------------
    // Phase 1: PLAN — ask LLM to decompose into sub-queries
    // ------------------------------------------------------------------
    this.state = 'planning';
    this.progress('Planning research sub-queries...');

    const planPrompt = `You are a research planner. Given a research goal, decompose it into 3-6 specific, independent sub-queries that can be researched in parallel.

Respond with ONLY a JSON array of strings, each being a specific search query. No explanation, just the JSON array.

Example:
["London fintech startups 2026 funding rounds notable companies", "London AI ML startups 2026 key players", "London climate tech green startups 2026"]

Keep queries specific and searchable. Each should target a distinct aspect of the research goal.`;

    let subQueries: string[];
    try {
      const planResponse = await callLLM(planPrompt, [{
        role: 'user',
        content: `Research goal: ${this.goal}`,
      }], [], 1024);

      const planText = planResponse.content
        .filter((b: ContentBlock) => b.type === 'text' && b.text)
        .map((b: ContentBlock) => b.text)
        .join('')
        .trim();

      // Parse JSON array from response
      const match = planText.match(/\[([\s\S]*?)\]/);
      if (!match) throw new Error(`Failed to parse plan: ${planText.substring(0, 200)}`);
      subQueries = JSON.parse(`[${match[1]}]`);
      console.log(`${tag} Plan: ${subQueries.length} sub-queries`);
    } catch (err: any) {
      console.error(`${tag} Planning failed:`, err.message);
      // Fallback: use the goal directly as a single query
      subQueries = [this.goal];
    }

    if (this.aborted) return;

    // Update notes with the plan
    this.updateNotes(
      `# Research: ${this.goal}\n\n` +
      `## Plan\n` +
      subQueries.map((q, i) => `${i + 1}. ${q}`).join('\n') +
      `\n\n## Status\nResearching ${subQueries.length} sub-queries in parallel...\n`
    );

    // Initialize sub-query tracking
    this.subQueryStates = subQueries.map(q => ({ query: q, state: 'pending', iterations: 0 }));

    // ------------------------------------------------------------------
    // Phase 2: EXECUTE — run all sub-queries in parallel
    // ------------------------------------------------------------------
    this.state = 'researching';
    this.progress(`Researching ${subQueries.length} sub-queries in parallel...`);

    const results = await Promise.all(
      subQueries.map((query, index) => {
        this.subQueryStates[index].state = 'running';
        return runSubQuery(query, index, this.ws, this.id, (msg) => {
          this.subQueryStates[index].state = msg;
        }).then(result => {
          this.subQueryStates[index].state = 'complete';
          // Update notes incrementally as each sub-query completes
          this.progress(`Completed: ${query.substring(0, 50)}...`);
          return result;
        }).catch(err => {
          this.subQueryStates[index].state = `error: ${err.message}`;
          return { query, findings: `Error: ${err.message}`, keyUrls: [] } as SubRunnerResult;
        });
      })
    );

    if (this.aborted) return;

    // ------------------------------------------------------------------
    // Phase 3: SYNTHESIZE — combine findings into final report
    // ------------------------------------------------------------------
    this.state = 'synthesizing';
    this.progress('Synthesizing findings into final report...');

    // Collect all key URLs
    const allUrls = results.flatMap(r => r.keyUrls);
    // Open browser panes for the top URLs (max 4)
    const uniqueUrls = [...new Map(allUrls.map(u => [u.url, u])).values()].slice(0, 4);
    for (const { title, url } of uniqueUrls) {
      send(this.ws, {
        type: 'command', name: 'create_pane',
        input: { pane_type: 'browser', label: title.substring(0, 30), url },
      });
    }

    // Ask LLM to synthesize all findings
    const synthesizePrompt = `You are a research synthesizer. You've received findings from ${results.length} parallel research sub-queries. Combine them into a single, well-organized research report in markdown.

Rules:
- Organize by theme/category, not by sub-query
- Remove duplicates, merge overlapping information
- Include concrete details: company names, funding amounts, key people, URLs
- Add a brief executive summary at the top
- Be comprehensive but well-structured`;

    const findingsSummary = results.map((r, i) =>
      `### Sub-query ${i + 1}: ${r.query}\n\n${r.findings}`
    ).join('\n\n---\n\n');

    try {
      const synthResponse = await callLLM(synthesizePrompt, [{
        role: 'user',
        content: `Research goal: ${this.goal}\n\n# Raw Findings\n\n${findingsSummary}`,
      }], [], 4096);

      const report = synthResponse.content
        .filter((b: ContentBlock) => b.type === 'text' && b.text)
        .map((b: ContentBlock) => b.text)
        .join('\n')
        .trim();

      this.updateNotes(report);
      console.log(`${tag} Final report: ${report.length} chars`);

      this.state = 'complete';
      this.progress('Research complete!');
      this.onComplete?.(report.substring(0, 200));
    } catch (err: any) {
      // If synthesis fails, just dump raw findings
      console.error(`${tag} Synthesis failed:`, err.message);
      const rawReport = `# Research: ${this.goal}\n\n` +
        `*Synthesis failed — showing raw findings*\n\n` +
        findingsSummary;
      this.updateNotes(rawReport);
      this.state = 'complete';
      this.onComplete?.('Research complete (raw findings).');
    }
  }
}
