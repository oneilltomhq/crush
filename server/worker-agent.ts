/** WorkerAgent — generic background worker wrapping a pi-agent-core Agent. */

import { Agent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';
import { registerBuiltInApiProviders } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { Model } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js';
import type { AgentTool, AgentEvent } from '/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js';

registerBuiltInApiProviders();

export type WorkerType = 'research' | 'shell' | 'browser' | 'generic';
export type WorkerState = 'starting' | 'running' | 'complete' | 'error' | 'aborted';

export interface WorkerOpts {
  id: string;
  type: WorkerType;
  goal: string;
  model: Model<any>;
  tools: AgentTool[];
  systemPrompt: string;
  getApiKey: (provider: string) => Promise<string | undefined> | string | undefined;
  onProgress?: (workerId: string, message: string) => void;
  onComplete?: (workerId: string, result: string) => void;
  onError?: (workerId: string, error: string) => void;
}

export interface WorkerStatus {
  id: string;
  type: WorkerType;
  goal: string;
  state: WorkerState;
  result?: string;
  error?: string;
  startedAt: number;
  completedAt?: number;
}

export class WorkerAgent {
  private agent: Agent;
  private opts: WorkerOpts;
  private state: WorkerState = 'starting';
  private result?: string;
  private error?: string;
  private startedAt: number = Date.now();
  private completedAt?: number;

  constructor(opts: WorkerOpts) {
    this.opts = opts;
    this.agent = new Agent({
      initialState: {
        model: opts.model,
        systemPrompt: opts.systemPrompt,
        tools: opts.tools,
      },
      getApiKey: async (provider) => opts.getApiKey(provider || opts.model.provider),
    });

    this.agent.subscribe((event: AgentEvent) => {
      if (event.type === 'tool_execution_start') {
        this.opts.onProgress?.(this.opts.id, `Tool: ${event.toolName}`);
      }
    });
  }

  start(): void {
    this.state = 'running';
    const prompt = `Accomplish the following goal. When finished, provide a clear final summary of what was done and the outcome.\n\nGoal: ${this.opts.goal}`;

    this.agent.prompt(prompt).then(() => {
      if (this.state === 'aborted') return;
      this.result = this.extractFinalText();
      this.state = 'complete';
      this.completedAt = Date.now();
      this.opts.onComplete?.(this.opts.id, this.result);
    }).catch((err: any) => {
      if (this.state === 'aborted') return;
      this.error = err?.message || String(err);
      this.state = 'error';
      this.completedAt = Date.now();
      this.opts.onError?.(this.opts.id, this.error!);
    });
  }

  abort(): void {
    this.state = 'aborted';
    this.completedAt = Date.now();
    this.agent.abort();
  }

  steer(text: string): void {
    this.agent.steer({ role: 'user', content: text, timestamp: Date.now() });
  }

  getStatus(): WorkerStatus {
    return {
      id: this.opts.id,
      type: this.opts.type,
      goal: this.opts.goal,
      state: this.state,
      result: this.result,
      error: this.error,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
    };
  }

  private extractFinalText(): string {
    const messages = this.agent.state.messages;
    const lastAssistant = [...messages].reverse().find(m => {
      if (m.role !== 'assistant') return false;
      return (m as any).content?.some((b: any) => b.type === 'text' && b.text?.trim());
    });
    if (!lastAssistant || lastAssistant.role !== 'assistant') return 'No output produced.';
    return (lastAssistant as any).content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n')
      .trim();
  }
}
