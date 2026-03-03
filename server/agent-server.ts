/**
 * Agent Server — port 8092
 *
 * Text-in/text-out LLM agent loop using Pi agent-core.
 * STT and TTS are client-side (ADR 005).
 * Refactored per ADR 008 to use pi-agent-core Agent class.
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
import { Agent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { registerBuiltInApiProviders, Type } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { Model, AssistantMessage } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { AgentTool, AgentEvent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { fohTools, shellWorkerTools, browserWorkerTools, readTodo, readProfile, PROFILE_DIR } from './pi-tools.js';
import { AgentRunner } from './agent-runner.js';
import { WorkerAgent, type WorkerType, type WorkerStatus } from './worker-agent.js';
import { send, extractText, notifyFoh } from './agent-helpers.js';

// Register built-in API providers (Anthropic, etc.)
registerBuiltInApiProviders();

// ---------------------------------------------------------------------------
// Research model config — MiniMax M2.5 via OpenRouter (cheapest option)
// $0.30/$1.10 per Mtok, ~$0.05/research report
// ---------------------------------------------------------------------------
const RESEARCH_MODEL: Model<'openai-completions'> = {
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
// FOH model — Llama 4 Scout via OpenRouter (Groq-hosted, fast inference)
// ~500ms round-trip, $0.08/$0.30 per Mtok
// ---------------------------------------------------------------------------
const FOH_MODEL: Model<'openai-completions'> = {
  id: 'meta-llama/llama-4-scout',
  name: 'Llama 4 Scout',
  api: 'openai-completions',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0.08, output: 0.3, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 327680,
  maxTokens: 1024,
};

// ---------------------------------------------------------------------------
// Worker model — Sonnet 4 via exe-gateway (capable, for shell/browser tasks)
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

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
if (!OPENROUTER_KEY) console.warn('[agent-server] OPENROUTER_API_KEY not set — research/FOH will fail');

function resolveApiKey(provider: string): string {
  if (provider === 'openrouter') return OPENROUTER_KEY;
  return 'gateway'; // exe-gateway accepts any non-empty key
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) { console.error(`Missing required env var: ${name}`); process.exit(1); }
  return val;
}

// Voice credentials — server-side, sent to client in init
const DEEPGRAM_API_KEY = requireEnv('DEEPGRAM_API_KEY');
const ELEVENLABS_API_KEY = requireEnv('ELEVENLABS_API_KEY');

const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '8092');



// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildFohSystemPrompt(): string {
  const todo = readTodo();
  const profile = readProfile();
  const hasProfile = profile && profile.trim().length > 0;
  return `You are Crush — a voice assistant that helps users with career strategy, job search, and professional positioning. You delegate heavy work to background workers but you drive the conversation.

The user speaks to you and you speak back via TTS. You are the front-of-house: always responsive, never slow.

## Voice rules (critical)

- Keep responses SHORT — 1-3 sentences. This is a conversation, not a monologue.
- No markdown formatting in speech. Just talk naturally.
- ALWAYS include spoken text in your response, even when using tools. Say what you're doing.
- Respond FAST. Never leave the user in silence.

## How you think

You are a CONSULTANT, not a task router. When a user brings you a goal:

1. UNDERSTAND before acting. Ask focused questions to fill gaps in your knowledge. What do they do? What are they looking for? Where? What constraints?
2. RESEARCH in rounds. Don't try to answer everything in one shot. First map the landscape, then drill into specifics, then synthesize a plan.
3. CONNECT findings. When research comes back, think about what it means and what to investigate next. Each round should build on the last.
4. ACCUMULATE context. Save what you learn about the user to their profile (write_file to ${PROFILE_DIR}/). This persists across sessions.

## Intake protocol

When the user starts a new topic and you don't know who they are yet:

### Step 1: Check existing profile
Read ${PROFILE_DIR}/about.md — if it exists and has substance, skip to step 3.

### Step 2: Understand what they want FIRST
Ask about their goal before asking about their background. "What kind of work are you looking for?" or "What's the situation?" Let them tell you what matters to them right now.

### Step 3: Then naturally offer to look them up
Once you understand the direction, asking about online profiles feels helpful rather than invasive. Something like "Do you have a GitHub or anything online I could look at? Saves me asking a load of questions about your background." Keep it casual and optional — not a checklist of links.

IMPORTANT caveats about profile data:
- LinkedIn profiles can be years out of date. They reflect where someone has been, not necessarily where they're going. Always weight what the user TELLS you over what their LinkedIn says.
- The user's current vibe/direction matters more than their history. If they say "I'm doing AI engineering now" but their LinkedIn says "Systems Engineer," trust what they say.
- Treat scraped profiles as background context, not ground truth. Frame it as "let me get a sense of your background" not "let me ingest your data."

When they do share a URL:
- Delegate a browser worker to scrape it and save to ${PROFILE_DIR}/
- While that runs, keep the conversation going — ask about goals, constraints, preferences
- If they offer multiple links, delegate workers in parallel
- If they'd rather just explain verbally, that's fine — save what they tell you to ${PROFILE_DIR}/about.md

### Step 4: Research with real context
Only delegate research once you have enough signal to write a SPECIFIC brief. Include everything you know — the worker has no memory of your conversation.

Bad: "research contract opportunities"
Good: "research the London contract market for senior AI/full-stack engineers with TypeScript, React, Three.js, and WebGPU experience. Focus on fintech, proptech, and AI startups. The user is near London, prefers hybrid, targeting 3-6 month contracts."

### Profile scraping — what to delegate
- LinkedIn URL → browser worker with auth_browse (user is logged in, can see full profiles). Save to ${PROFILE_DIR}/linkedin.md
- GitHub username → browser worker with browse (public). Scrape profile page, pinned repos, README if it's a profile repo. Save to ${PROFILE_DIR}/github.md
- X/Twitter URL → browser worker with browse. Scrape recent posts, bio, pinned tweet. Save to ${PROFILE_DIR}/x.md
- Personal website → browser worker with browse. Scrape key pages (about, portfolio, blog). Save to ${PROFILE_DIR}/website.md
- Resume URL → shell worker to download. Save to ${PROFILE_DIR}/resume.md

After a scraping worker completes, read the saved file (read_file) so you can use the content immediately in conversation and research briefs.

## Delegation

You delegate complex work to background workers:
- delegate_task with worker_type "research" — web research, market analysis, competitive intelligence
- delegate_task with worker_type "shell" — system commands, coding, file operations
- delegate_task with worker_type "browser" — web automation, browsing logged-in sites

When writing research briefs, be SPECIFIC. Include all relevant context: the user's background, location, target market, what you already know. The research worker has no memory of your conversation — everything it needs must be in the task description.

## Chained research

Complex goals need multiple research rounds. After a research worker completes:
1. Read the results (they'll be in a workspace pane)
2. Tell the user what you found — the key insight, not a full summary
3. Think about what's missing or what to drill into next
4. Delegate the next round with a brief that builds on prior findings
5. Save intermediate findings to the user's profile if they're reusable

Don't stop at one round unless the user's question was simple. Career strategy, market mapping, and positioning need layers of research.

## Proactive notifications

You receive [Worker notification] messages when workers complete or fail:
- Tell the user immediately what happened
- Summarize the key finding (not everything — the most useful insight)
- Suggest what to explore next or ask if they want to go deeper
- Do NOT use tools in notification responses — just speak

## Direct actions (no delegation needed)

- Reading/writing local files (read_file, write_file)
- Managing workspace panes (create_pane, remove_pane, scroll_pane)
- Updating the todo list
- Conversation, questions, and coaching

## Confirmation rule

Before any action on an external service (posting to X, editing LinkedIn, submitting forms, pushing code), ALWAYS show the plan and get explicit approval first. Research, reading, and local drafting proceed freely.

## User profile

Persistent context in ${PROFILE_DIR}/ (markdown files). Read these at the start of new topics. Update them when you learn new things about the user.

${hasProfile ? `### Current profile:\n\n${profile}` : 'No profile files yet. As you learn about the user — their skills, experience, goals, location, preferences — save key facts to ${PROFILE_DIR}/about.md so you remember next time.'}

## Todo list

${todo}

Today is ${new Date().toISOString().split('T')[0]}.`;
}


// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

interface Connection {
  ws: WebSocket;
  id: string;
  agent: Agent;          // FOH agent (Scout)
  processing: boolean;
  workers: Map<string, WorkerAgent | AgentRunner>;  // background workers
  workerCounter: number;
}

/**
 * Refresh the FOH system prompt with current profile data.
 * Call this after workers may have written to the profile directory.
 * This ensures Scout sees updated profile context mid-session.
 */
function refreshFohPrompt(conn: Connection): void {
  const newPrompt = buildFohSystemPrompt();
  conn.agent.setSystemPrompt(newPrompt);
  console.log(`[foh:${conn.id}] System prompt refreshed (profile may have changed)`);
}

// ---------------------------------------------------------------------------
// Worker system prompts
// ---------------------------------------------------------------------------

const SHELL_WORKER_PROMPT = `You are a shell/coding worker agent. Execute the given task using shell commands, file operations, and web searches.

You have full system access. Working directory is /home/exedev/crush.
Be thorough but efficient. When done, summarize what you did and the outcome.`;

const BROWSER_WORKER_PROMPT = `You are a browser automation worker agent. Execute the given task using CDP browser automation.

Tools:
- browse: control the server's headless Chromium (for general browsing, public pages)
- auth_browse: control the user's authenticated browser (for logged-in sites: LinkedIn, X, Gmail, etc.)
- web_search: Tavily search for information lookup
- read_file / write_file: read and save files locally

Workflow: open URL → snapshot (full page text) or snapshot -i (interactive elements) → interact with @refs → verify result.

## Profile scraping tasks

When asked to scrape a profile (LinkedIn, GitHub, X, personal site), your job is to:
1. Navigate to the URL
2. Use snapshot to get the full page content
3. Extract ALL relevant professional information: name, title, location, experience, skills, projects, bio, posts
4. Write a well-structured markdown summary to the specified output path (e.g. ${PROFILE_DIR}/linkedin.md)
5. Include sections: Summary, Experience, Skills, Projects, Notable details
6. Be thorough — this profile data will be used to inform career strategy and job search

For LinkedIn: use auth_browse (user is logged in). Scroll down to load the full profile before snapshotting.
For GitHub: use browse (public). Check the profile page, pinned repos, and any profile README (username/username repo).
For X: use browse. Get bio, pinned tweet, and recent posts that reveal professional interests.
For personal sites: use browse. Check about/portfolio/blog pages.

Be careful with auth_browse — you're controlling the user's real browser sessions.
When done, summarize what you scraped and where you saved it.`;

// ---------------------------------------------------------------------------
// Build FOH tools for a connection (includes delegation tools)
// ---------------------------------------------------------------------------

function buildFohTools(conn: Connection): AgentTool[] {
  const tools = fohTools(conn.ws);

  // delegate_task — creates a background worker
  const delegateTaskTool: AgentTool = {
    name: 'delegate_task',
    label: 'Delegate Task',
    description: `Delegate a task to a background worker agent. Returns immediately — the worker runs async.
Worker types:
- research: deep web research with parallel sub-queries. Use for any research, analysis, or information gathering.
- shell: system commands, coding, file operations, git, package management.
- browser: CDP browser automation, web scraping, authenticated site actions (LinkedIn, X, etc.).`,
    parameters: Type.Object({
      task: Type.String({ description: 'Clear, specific description of what to accomplish' }),
      worker_type: Type.Union([
        Type.Literal('research'),
        Type.Literal('shell'),
        Type.Literal('browser'),
      ], { description: 'Type of worker to use' }),
    }),
    execute: async (_id, params) => {
      const { task, worker_type } = params as { task: string; worker_type: WorkerType };
      const workerId = `w${++conn.workerCounter}`;
      const tag = `[worker:${workerId}]`;

      console.log(`${tag} Delegating ${worker_type}: "${task.substring(0, 80)}"`);

      if (worker_type === 'research') {
        // Use the specialized AgentRunner for research (3-phase pipeline)
        const notesPaneLabel = `Research: ${task.substring(0, 40)}${task.length > 40 ? '...' : ''}`;
        send(conn.ws, {
          type: 'command', name: 'create_pane',
          input: { pane_type: 'text', label: notesPaneLabel, content: `# Researching...\n\n*${task}*\n\nStarting research agent...` },
        });

        const runner = new AgentRunner({
          goal: task,
          ws: conn.ws,
          notesPaneLabel,
          model: RESEARCH_MODEL,
          getApiKey: resolveApiKey,
          onComplete: (summary) => {
            console.log(`${tag} Complete: ${summary.substring(0, 80)}`);
            send(conn.ws, { type: 'worker_complete', workerId, summary });
            refreshFohPrompt(conn);
            notifyFoh(conn, `Research worker ${workerId} finished. Task: "${task.substring(0, 60)}". Summary: ${summary.substring(0, 150)}`);
          },
          onProgress: (status) => console.log(`${tag} ${status}`),
          onError: (err) => {
            console.error(`${tag} Error: ${err}`);
            send(conn.ws, { type: 'worker_error', workerId, error: err });
            refreshFohPrompt(conn);
            notifyFoh(conn, `Research worker ${workerId} failed. Task: "${task.substring(0, 60)}". Error: ${err}`);
          },
        });
        conn.workers.set(workerId, runner);
        runner.start();
      } else {
        // Use generic WorkerAgent for shell/browser tasks
        const workerTools = worker_type === 'shell'
          ? shellWorkerTools()
          : browserWorkerTools(conn.ws);
        const workerPrompt = worker_type === 'shell'
          ? SHELL_WORKER_PROMPT
          : BROWSER_WORKER_PROMPT;

        // Create a pane for the worker's output
        const paneLabel = `${worker_type}: ${task.substring(0, 35)}${task.length > 35 ? '...' : ''}`;
        send(conn.ws, {
          type: 'command', name: 'create_pane',
          input: { pane_type: 'text', label: paneLabel, content: `*Working on: ${task}*\n\nStarting...` },
        });

        const worker = new WorkerAgent({
          id: workerId,
          type: worker_type,
          goal: task,
          model: WORKER_MODEL,
          tools: workerTools,
          systemPrompt: workerPrompt,
          getApiKey: resolveApiKey,
          onProgress: (wId, msg) => console.log(`${tag} ${msg}`),
          onComplete: (wId, result) => {
            console.log(`${tag} Complete (${result.length} chars)`);
            // Update the worker's pane with the result
            send(conn.ws, {
              type: 'command', name: 'update_pane',
              input: { label: paneLabel, content: result },
            });
            send(conn.ws, { type: 'worker_complete', workerId: wId, summary: result.substring(0, 200) });
            refreshFohPrompt(conn);
            notifyFoh(conn, `${worker_type} worker ${wId} finished. Task: "${task.substring(0, 60)}". Result: ${result.substring(0, 150)}`);
          },
          onError: (wId, err) => {
            console.error(`${tag} Error: ${err}`);
            send(conn.ws, { type: 'worker_error', workerId: wId, error: err });
            refreshFohPrompt(conn);
            notifyFoh(conn, `${worker_type} worker ${wId} failed. Task: "${task.substring(0, 60)}". Error: ${err}`);
          },
        });
        conn.workers.set(workerId, worker);
        worker.start();
      }

      return {
        content: [{ type: 'text', text: `Task delegated to ${worker_type} worker (${workerId}). Running in background.` }],
        details: { workerId },
      };
    },
  };

  // check_tasks — report on worker status
  const checkTasksTool: AgentTool = {
    name: 'check_tasks',
    label: 'Check Tasks',
    description: 'Check status of background workers. Use when user asks how things are going.',
    parameters: Type.Object({}),
    execute: async () => {
      if (conn.workers.size === 0) {
        return { content: [{ type: 'text', text: 'No background tasks running.' }], details: {} };
      }
      const lines: string[] = [];
      for (const [id, w] of conn.workers) {
        if (w instanceof AgentRunner) {
          const s = w.getStatus();
          lines.push(`${id} [research] "${s.goal.substring(0, 50)}" — ${s.state}`);
        } else {
          const s = w.getStatus();
          const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
          lines.push(`${id} [${s.type}] "${s.goal.substring(0, 50)}" — ${s.state} (${elapsed}s)`);
          if (s.result) lines.push(`  Result: ${s.result.substring(0, 100)}...`);
        }
      }
      return { content: [{ type: 'text', text: lines.join('\n') }], details: {} };
    },
  };

  // abort_task — cancel a running worker
  const abortTaskTool: AgentTool = {
    name: 'abort_task',
    label: 'Abort Task',
    description: 'Abort a background worker by ID. Use when user wants to cancel a task.',
    parameters: Type.Object({
      worker_id: Type.String({ description: 'Worker ID to abort (e.g. w1, w2)' }),
    }),
    execute: async (_id, params) => {
      const wId = (params as { worker_id: string }).worker_id;
      const worker = conn.workers.get(wId);
      if (!worker) {
        return { content: [{ type: 'text', text: `No worker found with ID ${wId}.` }], details: {} };
      }
      worker.abort();
      return { content: [{ type: 'text', text: `Worker ${wId} aborted.` }], details: {} };
    },
  };

  tools.push(delegateTaskTool, checkTasksTool, abortTaskTool);
  return tools;
}

// ---------------------------------------------------------------------------
// Process conversation start — agent speaks first
// ---------------------------------------------------------------------------

async function processStart(conn: Connection): Promise<void> {
  if (conn.processing) return;
  conn.processing = true;
  const tag = `[foh:${conn.id}]`;
  console.log(`${tag} Conversation started`);

  try {
    send(conn.ws, { type: 'thinking' });

    const todo = readTodo();
    const hasTodo = todo && !todo.includes('No todo file found');
    const prompt = hasTodo
      ? '[System: The user just opened Crush. They have a todo list. Greet briefly, mention it, ask what to tackle. One sentence + one question.]'
      : '[System: The user just opened Crush. Say hi in one sentence, ask what they want to work on. Do NOT list features.]';

    await conn.agent.prompt(prompt);

    // Extract the last assistant response
    const messages = conn.agent.state.messages;
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const spoken = lastAssistant ? extractText(lastAssistant) : '';

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
// Process user text — Pi Agent handles the full tool-use loop
// ---------------------------------------------------------------------------

async function processText(conn: Connection, userText: string): Promise<void> {
  if (!userText.trim()) return;
  if (conn.processing) {
    send(conn.ws, { type: 'error', message: 'Still processing previous request' });
    return;
  }

  conn.processing = true;
  const tag = `[foh:${conn.id}]`;
  console.log(`${tag} "${userText.substring(0, 80)}${userText.length > 80 ? '...' : ''}"`);

  try {
    send(conn.ws, { type: 'thinking' });

    // FOH agent stays lean — keep last 20 messages
    if (conn.agent.state.messages.length > 20) {
      const trimmed = conn.agent.state.messages.slice(-20);
      conn.agent.replaceMessages(trimmed);
    }

    // Run the agent loop — Pi handles tool calls internally
    await conn.agent.prompt(userText);

    // Extract spoken text from the LAST assistant message only.
    // FOH agent should produce one short response per turn.
    const messages = conn.agent.state.messages;
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const spoken = lastAssistant ? extractText(lastAssistant) : '';
    send(conn.ws, { type: 'response', text: spoken });
    if (spoken) {
      console.log(`${tag} Response: "${spoken.substring(0, 80)}${spoken.length > 80 ? '...' : ''}"`);
    }
  } catch (err: any) {
    console.error(`${tag} Error:`, err.message);
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
  console.log(`[foh:${id}] Client connected`);

  // Create FOH (front-of-house) agent — fast conversational model
  const agent = new Agent({
    initialState: {
      model: FOH_MODEL,
      systemPrompt: buildFohSystemPrompt(),
    },
    getApiKey: async (provider) => resolveApiKey(provider),
  });

  const conn: Connection = { ws, id, agent, processing: false, workers: new Map(), workerCounter: 0 };

  // Set FOH tools (they need the connection reference for delegation)
  agent.setTools(buildFohTools(conn));

  // Subscribe to FOH agent events for logging
  agent.subscribe((e: AgentEvent) => {
    if (e.type === 'tool_execution_start') {
      console.log(`[foh:${id}] Tool: ${e.toolName}(${JSON.stringify(e.args).substring(0, 100)})`);
    }
  });

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
      await processStart(conn);
    } else if (msg.type === 'text' && msg.text?.trim()) {
      await processText(conn, msg.text.trim());
    }
  });

  ws.on('close', () => {
    // Abort all workers on disconnect
    for (const [, w] of conn.workers) w.abort();
    console.log(`[foh:${id}] Disconnected (${conn.workers.size} workers aborted)`);
  });
  ws.on('error', (err: Error) => console.error(`[foh:${id}] Error:`, err.message));
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ port: WS_PORT });
const dummyConn = { ws: null as any, id: '0', agent: null as any, processing: false, workers: new Map(), workerCounter: 0 };
const toolNames = buildFohTools(dummyConn).map(t => t.name);
console.log(`Agent server (FOH/worker architecture) on ws://localhost:${WS_PORT}`);
console.log(`FOH model: ${FOH_MODEL.id} via OpenRouter (Groq-hosted)`);
console.log(`Worker models: research=${RESEARCH_MODEL.id}, shell/browser=${WORKER_MODEL.id}`);
console.log(`FOH tools: ${toolNames.join(', ')}`);
console.log(`Worker types: research (AgentRunner), shell (WorkerAgent), browser (WorkerAgent)`);

wss.on('connection', handleConnection);
wss.on('error', (err: Error) => console.error('[agent] Server error:', err.message));
