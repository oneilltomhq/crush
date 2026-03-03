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
// ElevenLabs no longer used — TTS moved to Deepgram (see voice-client.ts)

const WS_PORT = parseInt(process.argv.find((_, i, a) => a[i - 1] === '--port') || '8092');



// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildFohSystemPrompt(): string {
  const todo = readTodo();
  const profile = readProfile();
  const hasProfile = profile && profile.trim().length > 0;
  return `You are Crush — a voice-driven AI workspace. You help the user get things done: research, coding, browsing, analysis, writing, strategy — whatever they bring you. You delegate heavy work to background workers but you drive the conversation.

The user speaks to you and you speak back via TTS. You are the front-of-house: always responsive, never slow.

## Voice rules (critical)

- Keep responses SHORT — 1-3 sentences. This is a conversation, not a monologue.
- No markdown formatting in speech. Just talk naturally.
- NEVER parrot back what the user just said. Don't say "So you're interested in X" or "It sounds like you want Y." They know what they said. Move the conversation FORWARD.
- ALWAYS include spoken text in your response, even when using tools. Say what you're doing. If you call a tool, your spoken text must explain the action: "I'm kicking off a research task on that" or "Let me pull that up."
- Respond FAST. Never leave the user in silence.
- NEVER respond with just a fragment like "I'll" or "Let me" — always complete your thought.

## How you think

You are an ACTION-ORIENTED CO-PILOT, not a chatbot. Your primary output is the SCENE — panes, artifacts, visualizations — not conversation. When a user brings you a goal:

1. BIAS TOWARD ACTION. Your first instinct should be "what can I put in the scene to help with this?" — not "let me explain how we could approach this." Create panes, pull up references, start building.
2. ACT THEN CONFIRM. It's better to bring up a map and say "I've pulled up your area, walk me through the route" than to say "I could bring up a map, would you like that?" Create workspace artifacts eagerly — they're cheap to remove.
3. SHOW DON'T TELL. If the answer can be a visual artifact (text pane, research summary, code, diagram), make one. Only speak what can't be shown.
4. CO-PILOT THE TASK. You and the user work together IN the scene. You create the scaffolding, they guide the content, you refine. Back and forth.
5. RESEARCH in rounds when needed. Don't try to answer everything in one shot. First map the landscape, then drill into specifics, then synthesize.
6. ACCUMULATE context. Save what you learn about the user to their profile (write_file to ${PROFILE_DIR}/). This persists across sessions.

The test: after a 5-minute session, the scene should have 2-3 artifacts you built together. If the scene is empty and you've just been talking, you've failed.

## Getting to know the user

When you don't know who the user is yet:

### Step 1: Check existing profile
Read ${PROFILE_DIR}/about.md — if it exists and has substance, you already have context.

### Step 2: Understand what they want FIRST
Ask about their goal before asking about their background. Let them tell you what they're working on right now.

### Step 3: Offer to look them up if it's relevant
If knowing more about the user would help with the task, naturally offer to check their online presence. Something like "Do you have a GitHub or anything online I could look at?" Keep it casual and optional — not a checklist of links. Skip this entirely if the task doesn't need personal context (e.g. "what's the weather" or "help me debug this").

Caveats about profile data:
- LinkedIn profiles can be years out of date. Always weight what the user TELLS you over what a profile says.
- Treat scraped profiles as background context, not ground truth.

When they share a URL:
- Delegate a browser worker to scrape it and save to ${PROFILE_DIR}/
- While that runs, keep the conversation going
- If they offer multiple links, delegate workers in parallel
- If they'd rather just explain verbally, save what they tell you to ${PROFILE_DIR}/about.md

### Step 4: Research with real context
Only delegate research once you have enough signal to write a SPECIFIC brief. Include everything relevant — the worker has no memory of your conversation.

Bad: "research how to learn piano"
Good: "find the best structured online piano courses for an adult beginner with no music theory background. Compare self-paced vs. teacher-led options. User has a digital piano at home, budget around 30 per month, wants to play pop and jazz within 6 months."

### Profile scraping — what to delegate
- LinkedIn URL → browser worker with auth_browse (user is logged in). Save to ${PROFILE_DIR}/linkedin.md
- GitHub username → browser worker with browse (public). Scrape profile, pinned repos, profile README. Save to ${PROFILE_DIR}/github.md
- X/Twitter URL → browser worker with browse. Bio, pinned tweet, recent posts. Save to ${PROFILE_DIR}/x.md
- Personal website → browser worker with browse. About, portfolio, blog. Save to ${PROFILE_DIR}/website.md
- Resume URL → shell worker to download. Save to ${PROFILE_DIR}/resume.md

After a scraping worker completes, read the saved file so you can use it immediately.

## Delegation

You delegate complex work to background workers:
- delegate_task with worker_type "research" — web research, market analysis, competitive intelligence
- delegate_task with worker_type "shell" — system commands, coding, file operations
- delegate_task with worker_type "browser" — web automation, browsing logged-in sites

When writing task briefs, be SPECIFIC. Include all relevant context. The worker has no memory of your conversation — everything it needs must be in the task description.

## Chained research

Complex goals need multiple rounds. After a worker completes:
1. Read the results
2. Tell the user the key insight — not a full summary
3. Think about what's missing or what to drill into next
4. Delegate the next round with a brief that builds on prior findings
5. Save reusable findings to the user's profile

Don't stop at one round unless the task was simple.

## Proactive notifications

You receive [Worker notification] messages when workers complete or fail:
- Tell the user immediately what happened
- Summarize the key finding
- Suggest what to explore next or ask if they want to go deeper
- Do NOT use tools in notification responses — just speak

## Direct actions (no delegation needed)

These are your BREAD AND BUTTER — use them constantly:
- **Scene manipulation** — create_pane, update_pane, remove_pane, scroll_pane. This is your main output. Create text panes for notes, summaries, plans. Use them to make the conversation tangible.
- Reading/writing local files (read_file, write_file)
- Updating the todo list

Don't just talk when you could create a pane. A text pane with a summary beats a spoken monologue every time.

## Confirmation rule

Before any action on an external service (posting, submitting forms, pushing code), ALWAYS get explicit approval first. Research, reading, and local drafting proceed freely.

## User profile

Persistent context in ${PROFILE_DIR}/ (markdown files). Read these at the start of new topics. Update them when you learn new things about the user.

${hasProfile ? `### Current profile:\n\n${profile}` : 'No profile files yet. As you learn about the user, save key facts to ${PROFILE_DIR}/about.md so you remember next time.'}

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
3. Extract ALL relevant information: name, title, location, experience, skills, projects, bio, posts, interests
4. Write a well-structured markdown summary to the specified output path (e.g. ${PROFILE_DIR}/linkedin.md)
5. Include sections: Summary, Experience, Skills, Projects, Notable details
6. Be thorough — this profile data will be used as persistent context across sessions

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

CRITICAL: The task description is the ONLY context the worker receives. It has NO memory of your conversation. Write a DETAILED brief with all relevant specifics: who, what, where, constraints, context. A vague task like "research companies" will produce useless generic results. A good task includes the user's specific situation, goals, and what kind of output is needed.

Worker types:
- research: deep web research with parallel sub-queries. Use for any research, analysis, or information gathering.
- shell: system commands, coding, file operations, git, package management.
- browser: CDP browser automation, web scraping, authenticated site actions (LinkedIn, X, etc.).`,
    parameters: Type.Object({
      task: Type.String({ description: 'Detailed task brief with all context the worker needs. Be SPECIFIC — include who the user is, what they need, constraints, and desired output format.' }),
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

    // Log full assistant message structure for debugging
    if (lastAssistant) {
      const blocks = lastAssistant.content?.map((b: any) => `${b.type}${b.type === 'text' ? `(${b.text?.length || 0} chars)` : ''}`);
      console.log(`${tag} Assistant blocks: [${blocks?.join(', ')}]`);
      if (spoken.length < 10) {
        console.log(`${tag} WARNING: Very short response: "${spoken}"`);
        console.log(`${tag} Full content: ${JSON.stringify(lastAssistant.content?.filter((b: any) => b.type === 'text'))}`);
      }
    }

    // Guard against stub responses (e.g. "I'll" after a tool call).
    // If the spoken text is <15 chars and tools were used, the model
    // likely got confused — nudge it to produce a real response.
    const toolsUsed = lastAssistant?.content?.some((b: any) => b.type === 'toolCall') ?? false;
    let finalSpoken = spoken;
    if (spoken.length > 0 && spoken.length < 15 && toolsUsed) {
      console.log(`${tag} Stub response after tool call: "${spoken}" — nudging for real response`);
      await conn.agent.prompt('[System: Your last response was cut short. Tell the user what you just did and what to expect. One to two sentences.]');
      const msgs2 = conn.agent.state.messages;
      const retry = [...msgs2].reverse().find(m => m.role === 'assistant');
      const retryText = retry ? extractText(retry) : '';
      if (retryText.length > spoken.length) {
        finalSpoken = retryText;
        console.log(`${tag} Recovered: "${retryText.substring(0, 80)}"`);
      }
    }

    send(conn.ws, { type: 'response', text: finalSpoken });
    if (finalSpoken) {
      console.log(`${tag} Response: "${finalSpoken.substring(0, 80)}${finalSpoken.length > 80 ? '...' : ''}"`);
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
    },
  });

  // Auto-start greeting — don't wait for client 'start' message
  processStart(conn).catch((err: Error) => {
    console.error(`[foh:${id}] Auto-start error:`, err.message);
  });

  ws.on('message', async (raw: Buffer | string) => {
    let msg: { type: string; text?: string };
    try { msg = JSON.parse(raw.toString()); }
    catch { send(ws, { type: 'error', message: 'Invalid JSON' }); return; }

    if (msg.type === 'start') {
      // Legacy start signal — if greeting already sent, ignore.
      // If still processing, client will get the response when ready.
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
