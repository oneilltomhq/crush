/**
 * AgentRunner — autonomous background agent for multi-step tasks.
 *
 * Three-phase design (see ADR 007):
 *   1. PLAN — LLM decomposes the goal into 3-6 parallel sub-queries
 *   2. EXECUTE — sub-queries run as parallel sub-runners, each with its own
 *      Pi Agent instance + conversation. All run concurrently.
 *   3. SYNTHESIZE — parent runner collects all findings and writes final report.
 *
 * Refactored per ADR 008 to use pi-agent-core Agent class instead of
 * hand-rolled LLM calls and tool dispatch.
 */

import { WebSocket } from 'ws';
import { Agent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { registerBuiltInApiProviders, completeSimple } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { Model, Api, AssistantMessage } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import { researchSubTools, tavilySearch } from './pi-tools.js';

// Register Anthropic (and other built-in) providers once
registerBuiltInApiProviders();

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SUB_RUNNER_MAX_ITERATIONS = 10;

// Default model — can be overridden by passing a different Model to the runner
const DEFAULT_MODEL: Model<'anthropic-messages'> = {
  id: 'claude-sonnet-4-20250514',
  name: 'Sonnet 4',
  api: 'anthropic-messages',
  provider: 'anthropic',
  baseUrl: 'http://169.254.169.254/gateway/llm/anthropic',
  reasoning: false,
  input: ['text'],
  cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentRunnerOpts {
  goal: string;
  ws: WebSocket;
  notesPaneLabel: string;
  model?: Model<any>;
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

interface SubRunnerResult {
  query: string;
  findings: string;
  keyUrls: { title: string; url: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function send(ws: WebSocket, msg: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Use completeSimple for one-shot calls (planning, synthesis) — no tools needed. */
async function oneShot(
  model: Model<any>,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 4096,
): Promise<string> {
  const response: AssistantMessage = await completeSimple(model, {
    systemPrompt,
    messages: [{ role: 'user', content: userMessage, timestamp: Date.now() }],
  }, { apiKey: 'not-needed', maxTokens });

  return response.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text)
    .join('\n')
    .trim();
}

// ---------------------------------------------------------------------------
// SubRunner — one sub-query via a Pi Agent with research tools
// ---------------------------------------------------------------------------

async function runSubQuery(
  query: string,
  index: number,
  parentId: string,
  model: Model<any>,
  onProgress: (msg: string) => void,
): Promise<SubRunnerResult> {
  const tag = `[${parentId}:sub${index}]`;
  console.log(`${tag} Starting: "${query}"`);
  onProgress(`Sub-query ${index + 1}: ${query}`);

  const keyUrls: { title: string; url: string }[] = [];
  let iterations = 0;

  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: `You are a focused research sub-agent. You have ONE specific query to research.

Rules:
- Start with web_search — it returns clean, structured results instantly
- Only use browse if you need to read a specific page in more depth
- Stay focused on your specific query — don't go off-topic
- Extract concrete facts: names, numbers, dates, URLs
- 1-3 tool calls should be enough. Don't over-search.
- Your final response (when you stop using tools) should be a structured summary in markdown
- Include source URLs

Today is ${new Date().toISOString().split('T')[0]}.`,
      tools: researchSubTools(),
    },
    getApiKey: async () => 'not-needed',
  });

  // Track URLs from tool calls
  agent.subscribe((e) => {
    if (e.type === 'tool_execution_start') {
      iterations++;
      console.log(`${tag} Tool: ${e.toolName} (iteration ${iterations})`);
    }
    if (e.type === 'tool_execution_end' && !e.isError) {
      // Extract URLs from web_search results
      const resultText = e.result?.content?.[0]?.text || '';
      const urlMatches = resultText.matchAll(/URL: (https?:\/\/\S+)/g);
      for (const m of urlMatches) {
        keyUrls.push({ title: query.substring(0, 40), url: m[1] });
      }
    }
    if (e.type === 'turn_start' && iterations >= SUB_RUNNER_MAX_ITERATIONS) {
      console.log(`${tag} Iteration limit reached, aborting`);
      agent.abort();
    }
  });

  try {
    await agent.prompt(`Research this specific query: ${query}\n\nUse web_search first, then browse specific pages if needed. Report back with structured findings.`);
  } catch (err: any) {
    console.error(`${tag} Agent error:`, err.message);
    return { query, findings: `Error researching: ${err.message}`, keyUrls };
  }

  // Extract the final assistant response (the last message)
  const messages = agent.state.messages;
  const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
  if (!lastAssistant || lastAssistant.role !== 'assistant') {
    return { query, findings: 'No findings produced.', keyUrls };
  }

  const findings = (lastAssistant as any).content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();

  console.log(`${tag} Complete after ${iterations} tool calls (${findings.length} chars)`);
  return { query, findings, keyUrls };
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
  private model: Model<any>;
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
    this.model = opts.model || DEFAULT_MODEL;
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
    // Phase 1: PLAN — one-shot LLM call to decompose into sub-queries
    // ------------------------------------------------------------------
    this.state = 'planning';
    this.progress('Planning research sub-queries...');

    let subQueries: string[];
    try {
      const planText = await oneShot(
        this.model,
        `You are a research planner. Given a research goal, decompose it into 3-6 specific, independent sub-queries that can be researched in parallel.

Respond with ONLY a JSON array of strings, each being a specific search query. No explanation, just the JSON array.

Example:
["London fintech startups 2026 funding rounds notable companies", "London AI ML startups 2026 key players", "London climate tech green startups 2026"]

Keep queries specific and searchable. Each should target a distinct aspect of the research goal.`,
        `Research goal: ${this.goal}`,
        1024,
      );

      const match = planText.match(/\[([\s\S]*?)\]/);
      if (!match) throw new Error(`Failed to parse plan: ${planText.substring(0, 200)}`);
      subQueries = JSON.parse(`[${match[1]}]`);
      console.log(`${tag} Plan: ${subQueries.length} sub-queries`);
    } catch (err: any) {
      console.error(`${tag} Planning failed:`, err.message);
      subQueries = [this.goal];
    }

    if (this.aborted) return;

    this.updateNotes(
      `# Research: ${this.goal}\n\n` +
      `## Plan\n` +
      subQueries.map((q, i) => `${i + 1}. ${q}`).join('\n') +
      `\n\n## Status\nResearching ${subQueries.length} sub-queries in parallel...\n`
    );

    this.subQueryStates = subQueries.map(q => ({ query: q, state: 'pending', iterations: 0 }));

    // ------------------------------------------------------------------
    // Phase 2: EXECUTE — run all sub-queries in parallel via Pi Agents
    // ------------------------------------------------------------------
    this.state = 'researching';
    this.progress(`Researching ${subQueries.length} sub-queries in parallel...`);

    const results = await Promise.all(
      subQueries.map((query, index) => {
        this.subQueryStates[index].state = 'running';
        return runSubQuery(query, index, this.id, this.model, (msg) => {
          this.subQueryStates[index].state = msg;
        }).then(result => {
          this.subQueryStates[index].state = 'complete';
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
    // Phase 3: SYNTHESIZE — one-shot LLM call to merge findings
    // ------------------------------------------------------------------
    this.state = 'synthesizing';
    this.progress('Synthesizing findings into final report...');

    // Open browser panes for top URLs (max 4)
    const allUrls = results.flatMap(r => r.keyUrls);
    const uniqueUrls = [...new Map(allUrls.map(u => [u.url, u])).values()].slice(0, 4);
    for (const { title, url } of uniqueUrls) {
      send(this.ws, {
        type: 'command', name: 'create_pane',
        input: { pane_type: 'browser', label: title.substring(0, 30), url },
      });
    }

    const findingsSummary = results.map((r, i) =>
      `### Sub-query ${i + 1}: ${r.query}\n\n${r.findings}`
    ).join('\n\n---\n\n');

    try {
      const report = await oneShot(
        this.model,
        `You are a research synthesizer. You've received findings from ${results.length} parallel research sub-queries. Combine them into a single, well-organized research report in markdown.

Rules:
- Organize by theme/category, not by sub-query
- Remove duplicates, merge overlapping information
- Include concrete details: company names, funding amounts, key people, URLs
- Add a brief executive summary at the top
- Be comprehensive but well-structured`,
        `Research goal: ${this.goal}\n\n# Raw Findings\n\n${findingsSummary}`,
        4096,
      );

      this.updateNotes(report);
      console.log(`${tag} Final report: ${report.length} chars`);

      this.state = 'complete';
      this.progress('Research complete!');
      this.onComplete?.(report.substring(0, 200));
    } catch (err: any) {
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
