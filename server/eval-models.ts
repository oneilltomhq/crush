/**
 * eval-models.ts — Side-by-side model eval for research pipeline.
 *
 * Runs the same research query with two model strategies:
 *   A) Claude Sonnet 4 everywhere (via exe-gateway) — baseline
 *   B) GLM-5 orchestration + MiniMax M2.5 sub-runners (via OpenRouter) — cheap
 *
 * Reports: time, report length, cost estimates, and writes both reports for
 * manual quality comparison.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... npx tsx server/eval-models.ts ["research goal"]
 */

import { WebSocket } from 'ws';
import { registerBuiltInApiProviders, completeSimple } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { Model, AssistantMessage } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import { Agent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { researchSubTools, tavilySearch } from './pi-tools.js';
import fs from 'fs';
import path from 'path';

// Load .env manually (no dotenv dependency)
const envPath = path.resolve(process.cwd(), '.env');
try {
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.substring(0, eq);
    const val = trimmed.substring(eq + 1);
    if (!process.env[key]) process.env[key] = val;
  }
} catch {}

registerBuiltInApiProviders();

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------

const SONNET: Model<'anthropic-messages'> = {
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

const GLM5: Model<'openai-completions'> = {
  id: 'z-ai/glm-5',
  name: 'GLM 5',
  api: 'openai-completions',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0.95, output: 2.55, cacheRead: 0.2, cacheWrite: 0 },
  contextWindow: 204800,
  maxTokens: 131072,
};

const MINIMAX: Model<'openai-completions'> = {
  id: 'minimax/minimax-m2.5',
  name: 'MiniMax M2.5',
  api: 'openai-completions',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0.3, output: 1.1, cacheRead: 0.15, cacheWrite: 0 },
  contextWindow: 196608,
  maxTokens: 65536,
};

// ---------------------------------------------------------------------------
// API key resolver
// ---------------------------------------------------------------------------

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
if (!OPENROUTER_KEY) {
  console.error('ERROR: Set OPENROUTER_API_KEY in .env or environment');
  process.exit(1);
}

function getApiKey(provider: string): string {
  if (provider === 'openrouter') return OPENROUTER_KEY;
  return 'gateway';
}

// ---------------------------------------------------------------------------
// Plan parsing — extract JSON array from LLM output (handles code fences, etc.)
// ---------------------------------------------------------------------------

function parsePlanJson(text: string): string[] {
  // Strip markdown code fences
  const stripped = text.replace(/```(?:json)?\n?/g, '').trim();
  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  // Fallback: find first [...] in the text
  const match = stripped.match(/\[([\s\S]*?)\]/);
  if (match) {
    return JSON.parse(`[${match[1]}]`);
  }
  throw new Error('No JSON array found');
}

// ---------------------------------------------------------------------------
// Lightweight research pipeline (no WebSocket, no pane commands)
// ---------------------------------------------------------------------------

interface EvalResult {
  strategy: string;
  report: string;
  durationMs: number;
  subQueries: string[];
  usageSummary: { phase: string; model: string; tokens: number; cost: number }[];
  totalCost: number;
}

async function oneShot(
  model: Model<any>,
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 4096,
): Promise<{ text: string; usage: any }> {
  const response: AssistantMessage = await completeSimple(model, {
    systemPrompt,
    messages: [{ role: 'user', content: userMessage, timestamp: Date.now() }],
  }, { apiKey: getApiKey(model.provider), maxTokens });

  const text = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as any).text)
    .join('\n')
    .trim();

  return { text, usage: response.usage };
}

async function runSubQuery(
  query: string,
  index: number,
  model: Model<any>,
): Promise<{ findings: string; usage: { tokens: number; cost: number } }> {
  let totalTokens = 0;
  let totalCost = 0;
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
    getApiKey: async (provider) => getApiKey(provider || model.provider),
  });

  agent.subscribe((e) => {
    if (e.type === 'tool_execution_start') {
      iterations++;
    }
    if (e.type === 'response_complete') {
      const usage = (e as any).response?.usage || (e as any).usage;
      if (usage) {
        totalTokens += usage.totalTokens || 0;
        totalCost += usage.cost?.total || 0;
      }
    }
    if (e.type === 'turn_start' && iterations >= 10) {
      agent.abort();
    }
  });

  try {
    await agent.prompt(`Research this specific query: ${query}\n\nUse web_search first, then browse specific pages if needed. Report back with structured findings.`);
  } catch (err: any) {
    // may abort
  }

  // Extract final response — find last assistant message with actual text
  const messages = agent.state.messages;
  const lastAssistant = [...messages].reverse().find(m => {
    if (m.role !== 'assistant') return false;
    return (m as any).content.some((b: any) => b.type === 'text' && b.text?.trim());
  });
  // Sum up usage from all assistant messages
  for (const msg of messages) {
    if (msg.role === 'assistant') {
      const u = (msg as any).usage;
      if (u) {
        totalTokens += u.totalTokens || 0;
        totalCost += u.cost?.total || 0;
      }
    }
  }

  const findings = lastAssistant?.role === 'assistant'
    ? (lastAssistant as any).content
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n')
        .trim()
    : 'No findings.';

  return { findings, usage: { tokens: totalTokens, cost: totalCost } };
}

async function runResearch(
  strategy: string,
  orchestrationModel: Model<any>,
  subRunnerModel: Model<any>,
  goal: string,
): Promise<EvalResult> {
  const start = Date.now();
  const usageSummary: EvalResult['usageSummary'] = [];

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Strategy: ${strategy}`);
  console.log(`  Orchestration: ${orchestrationModel.name} (${orchestrationModel.id})`);
  console.log(`  Sub-runners:   ${subRunnerModel.name} (${subRunnerModel.id})`);
  console.log(`${'='.repeat(60)}`);

  // Phase 1: PLAN
  console.log('\n[PLAN] Decomposing research goal...');
  const planResult = await oneShot(
    orchestrationModel,
    `You are a research planner. Given a research goal, decompose it into 3-6 specific, independent sub-queries that can be researched in parallel.

Respond with ONLY a JSON array of strings, each being a specific search query. No explanation, just the JSON array.

Example:
["London fintech startups 2026 funding rounds", "London AI ML startups 2026 key players", "London climate tech green startups 2026"]

Keep queries specific and searchable.`,
    `Research goal: ${goal}`,
    1024,
  );
  usageSummary.push({
    phase: 'plan',
    model: orchestrationModel.id,
    tokens: planResult.usage?.totalTokens || 0,
    cost: planResult.usage?.cost?.total || 0,
  });

  let subQueries: string[];
  try {
    subQueries = parsePlanJson(planResult.text);
  } catch (e: any) {
    console.error(`  Failed to parse plan: ${e.message}`);
    console.error(`  Raw text: ${planResult.text.substring(0, 300)}`);
    subQueries = [goal];
  }
  console.log(`  Sub-queries (${subQueries.length}):`);
  subQueries.forEach((q, i) => console.log(`    ${i + 1}. ${q}`));

  // Phase 2: EXECUTE
  console.log('\n[EXECUTE] Running sub-queries in parallel...');
  const subResults = await Promise.all(
    subQueries.map(async (query, i) => {
      const t0 = Date.now();
      console.log(`  [sub${i}] Starting: ${query.substring(0, 60)}...`);
      const result = await runSubQuery(query, i, subRunnerModel);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`  [sub${i}] Done (${dt}s, ${result.findings.length} chars, $${result.usage.cost.toFixed(4)})`);
      usageSummary.push({
        phase: `sub${i}`,
        model: subRunnerModel.id,
        tokens: result.usage.tokens,
        cost: result.usage.cost,
      });
      return result;
    })
  );

  // Phase 3: SYNTHESIZE
  console.log('\n[SYNTHESIZE] Merging findings...');
  const findingsSummary = subResults.map((r, i) =>
    `### Sub-query ${i + 1}: ${subQueries[i]}\n\n${r.findings}`
  ).join('\n\n---\n\n');

  const synthResult = await oneShot(
    orchestrationModel,
    `You are a research synthesizer. Combine findings from ${subResults.length} parallel research sub-queries into a single, well-organized research report in markdown.

Rules:
- Organize by theme/category, not by sub-query
- Remove duplicates, merge overlapping information
- Include concrete details: company names, funding amounts, key people, URLs
- Add a brief executive summary at the top
- Be comprehensive but well-structured`,
    `Research goal: ${goal}\n\n# Raw Findings\n\n${findingsSummary}`,
    4096,
  );
  usageSummary.push({
    phase: 'synthesize',
    model: orchestrationModel.id,
    tokens: synthResult.usage?.totalTokens || 0,
    cost: synthResult.usage?.cost?.total || 0,
  });

  const totalCost = usageSummary.reduce((s, u) => s + u.cost, 0);
  const durationMs = Date.now() - start;

  console.log(`\n  Report: ${synthResult.text.length} chars`);
  console.log(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`  Total cost: $${totalCost.toFixed(4)}`);

  return {
    strategy,
    report: synthResult.text,
    durationMs,
    subQueries,
    usageSummary,
    totalCost,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const goal = process.argv.slice(2).join(' ')
    || 'London tech startup clusters: geography, key companies, recent funding, and coworking hubs';

  console.log(`Research goal: ${goal}`);
  console.log(`OpenRouter key: ${OPENROUTER_KEY.substring(0, 12)}...`);

  const strategies = process.env.STRATEGY;

  let resultA: EvalResult | null = null;
  let resultB: EvalResult | null = null;
  let resultC: EvalResult | null = null;

  if (!strategies || strategies === 'A' || strategies === 'both') {
    // Strategy A: Claude Sonnet 4 everywhere (exe-gateway)
    resultA = await runResearch('A: Sonnet 4 everywhere', SONNET, SONNET, goal);
    fs.writeFileSync('/tmp/eval-report-A.md', resultA.report);
    console.log('  Written to /tmp/eval-report-A.md');
  }

  if (!strategies || strategies === 'B' || strategies === 'both') {
    // Strategy B: GLM-5 orchestration + MiniMax M2.5 sub-runners
    resultB = await runResearch('B: GLM-5 + MiniMax M2.5', GLM5, MINIMAX, goal);
    fs.writeFileSync('/tmp/eval-report-B.md', resultB.report);
    console.log('  Written to /tmp/eval-report-B.md');
  }

  if (strategies === 'C') {
    // Strategy C: MiniMax M2.5 everywhere (cheapest)
    resultC = await runResearch('C: MiniMax M2.5 everywhere', MINIMAX, MINIMAX, goal);
    fs.writeFileSync('/tmp/eval-report-C.md', resultC.report);
    console.log('  Written to /tmp/eval-report-C.md');
  }

  // Summary comparison
  console.log('\n' + '='.repeat(60));
  console.log('COMPARISON SUMMARY');
  console.log('='.repeat(60));

  const rows: [string, string, string][] = [
    ['Metric', 'A: Sonnet 4', 'B: GLM-5/MiniMax'],
    ['', '─'.repeat(16), '─'.repeat(16)],
  ];

  if (resultA && resultB) {
    rows.push(
      ['Duration', `${(resultA.durationMs / 1000).toFixed(1)}s`, `${(resultB.durationMs / 1000).toFixed(1)}s`],
      ['Report length', `${resultA.report.length} chars`, `${resultB.report.length} chars`],
      ['Sub-queries', `${resultA.subQueries.length}`, `${resultB.subQueries.length}`],
      ['Total cost', `$${resultA.totalCost.toFixed(4)}`, `$${resultB.totalCost.toFixed(4)}`],
      ['Cost ratio', '1.0x', `${(resultB.totalCost / resultA.totalCost).toFixed(2)}x`],
    );
  } else if (resultA) {
    rows.push(
      ['Duration', `${(resultA.durationMs / 1000).toFixed(1)}s`, 'N/A'],
      ['Report length', `${resultA.report.length} chars`, 'N/A'],
      ['Total cost', `$${resultA.totalCost.toFixed(4)}`, 'N/A'],
    );
  } else if (resultB) {
    rows.push(
      ['Duration', 'N/A', `${(resultB.durationMs / 1000).toFixed(1)}s`],
      ['Report length', 'N/A', `${resultB.report.length} chars`],
      ['Total cost', 'N/A', `$${resultB.totalCost.toFixed(4)}`],
    );
  } else if (resultC) {
    rows.push(
      ['Duration', 'N/A', `${(resultC.durationMs / 1000).toFixed(1)}s`],
      ['Report length', 'N/A', `${resultC.report.length} chars`],
      ['Total cost', 'N/A', `$${resultC.totalCost.toFixed(4)}`],
    );
  }

  for (const [label, a, b] of rows) {
    console.log(`  ${label.padEnd(15)} ${a.padEnd(18)} ${b}`);
  }

  console.log('\nReports written to /tmp/eval-report-A.md and /tmp/eval-report-B.md');
  console.log('Review both reports manually for quality comparison.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
