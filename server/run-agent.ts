#!/usr/bin/env npx tsx
/**
 * CLI runner for Crush agents.
 *
 * Usage:
 *   npx tsx server/run-agent.ts <agent-name> "<goal>"
 *
 * Example:
 *   npx tsx server/run-agent.ts prospector "Find 4 contract opportunities in agentic AI, London/remote, posted in last 30 days"
 *
 * Reuses agent definitions, skills, tools, and models from the server codebase
 * but runs headless — no WebSocket, no panes.
 */

import { Agent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { registerBuiltInApiProviders } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { Model, AssistantMessage } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { AgentTool, AgentEvent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import {
  makeShellTool, makeReadFileTool, makeWriteFileTool,
  makeWebSearchTool, makeDownloadTool, makeStandaloneBrowseTool,
  makeStandaloneAuthBrowseTool,
} from './pi-tools.js';
import { loadAgents, getAgent, loadSkills, formatSkillsForPrompt } from './agent-loader.js';

registerBuiltInApiProviders();

// ---------------------------------------------------------------------------
// Models (same as agent-server.ts)
// ---------------------------------------------------------------------------
const WORKER_MODEL: Model<'anthropic-messages'> = {
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

const MODEL_ALIASES: Record<string, Model<any>> = {
  worker: WORKER_MODEL,
};

// ---------------------------------------------------------------------------
// Tool registry (standalone — no WebSocket)
// ---------------------------------------------------------------------------
const TOOL_MAP: Record<string, () => AgentTool> = {
  shell: makeShellTool,
  read_file: makeReadFileTool,
  write_file: makeWriteFileTool,
  web_search: makeWebSearchTool,
  download: makeDownloadTool,
  browse: makeStandaloneBrowseTool,
  auth_browse: makeStandaloneAuthBrowseTool,
};

function resolveToolsStandalone(toolNames: string[]): AgentTool[] {
  const tools: AgentTool[] = [];
  for (const name of toolNames) {
    const factory = TOOL_MAP[name.trim()];
    if (factory) tools.push(factory());
    else console.warn(`[run-agent] Unknown tool: ${name}`);
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const [agentName, ...goalParts] = process.argv.slice(2);
  const goal = goalParts.join(' ');

  if (!agentName || !goal) {
    console.error('Usage: npx tsx server/run-agent.ts <agent-name> "<goal>"');
    process.exit(1);
  }

  // Load agents and skills
  loadAgents();
  loadSkills();
  const agentDef = getAgent(agentName);
  if (!agentDef) {
    console.error(`Unknown agent: ${agentName}`);
    console.error(`Available: ${Array.from(loadAgents().keys()).join(', ')}`);
    process.exit(1);
  }

  // Resolve model
  const model = MODEL_ALIASES[agentDef.modelAlias || 'worker'] || WORKER_MODEL;

  // Resolve tools
  const tools = resolveToolsStandalone(agentDef.toolNames);

  // Build system prompt with skills
  const skillsBlock = agentDef.skillNames.length > 0 ? '\n\n' + formatSkillsForPrompt(agentDef.skillNames) : '';
  const systemPrompt = agentDef.systemPrompt + skillsBlock;

  console.log(`[run-agent] Agent: ${agentDef.name}`);
  console.log(`[run-agent] Model: ${model.name}`);
  console.log(`[run-agent] Tools: ${tools.map(t => t.name).join(', ')}`);
  console.log(`[run-agent] Skills: ${agentDef.skillNames.join(', ') || '(none)'}`);
  console.log(`[run-agent] Goal: ${goal}`);
  console.log('---');

  const agent = new Agent({
    initialState: {
      model,
      systemPrompt,
      tools,
    },
    getApiKey: async (provider) => {
      if (provider === 'openrouter') return process.env.OPENROUTER_API_KEY || '';
      return 'gateway';
    },
  });

  // Subscribe to events for live progress
  agent.subscribe((event: AgentEvent) => {
    if (event.type === 'tool_execution_start') {
      console.log(`[tool] ${event.toolName}`);
    } else if (event.type === 'tool_execution_end') {
      // Truncate long results
      const result = String(event.result || '').substring(0, 200);
      console.log(`[tool] ${event.toolName} → ${result}`);
    }
  });

  const prompt = `Accomplish the following goal. When finished, provide a clear final summary of what was done and the outcome.\n\nGoal: ${goal}`;

  try {
    await agent.prompt(prompt);
    // Extract final text from last assistant message
    const messages = agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant' && typeof msg.content === 'string') {
        console.log('\n=== RESULT ===');
        console.log(msg.content);
        break;
      } else if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const texts = msg.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        if (texts) {
          console.log('\n=== RESULT ===');
          console.log(texts);
          break;
        }
      }
    }
  } catch (err) {
    console.error('[run-agent] Error:', err);
    process.exit(1);
  }
}

main();
