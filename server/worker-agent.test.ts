import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock pi-agent-core Agent
// ---------------------------------------------------------------------------
const mockPrompt = vi.fn();
const mockAbort = vi.fn();
const mockSteer = vi.fn();
const mockSubscribe = vi.fn().mockReturnValue(() => {});
const mockState = {
  messages: [] as any[],
};

vi.mock('/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-agent-core/dist/index.js', () => ({
  Agent: vi.fn().mockImplementation(function(this: any) {
    this.prompt = mockPrompt;
    this.abort = mockAbort;
    this.steer = mockSteer;
    this.subscribe = mockSubscribe;
    this.state = mockState;
    this.setTools = vi.fn();
  }),
}));

vi.mock('/usr/lib/node_modules/openclaw/node_modules/@mariozechner/pi-ai/dist/index.js', () => ({
  registerBuiltInApiProviders: vi.fn(),
}));

import { WorkerAgent, type WorkerOpts } from './worker-agent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpts(overrides: Partial<WorkerOpts> = {}): WorkerOpts {
  return {
    id: 'w1',
    type: 'shell',
    goal: 'echo hello',
    model: { id: 'test', name: 'test', api: 'anthropic-messages', provider: 'anthropic', baseUrl: '', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as any,
    tools: [],
    systemPrompt: 'test',
    getApiKey: () => 'key',
    ...overrides,
  };
}

function assistantMsg(text: string) {
  return { role: 'assistant', content: [{ type: 'text', text }] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkerAgent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockPrompt.mockReset();
    mockAbort.mockReset();
    mockSteer.mockReset();
    mockSubscribe.mockReset().mockReturnValue(() => {});
    mockState.messages = [];
  });

  describe('initial state', () => {
    it('starts in starting state', () => {
      const w = new WorkerAgent(makeOpts());
      const s = w.getStatus();
      expect(s.state).toBe('starting');
      expect(s.id).toBe('w1');
      expect(s.type).toBe('shell');
      expect(s.goal).toBe('echo hello');
      expect(s.result).toBeUndefined();
      expect(s.error).toBeUndefined();
    });
  });

  describe('start() — happy path', () => {
    it('transitions to running then complete, calls onComplete', async () => {
      const onComplete = vi.fn();
      const onProgress = vi.fn();

      // prompt resolves successfully
      mockPrompt.mockResolvedValueOnce(undefined);
      mockState.messages = [assistantMsg('Done! Echoed hello.')];

      const w = new WorkerAgent(makeOpts({ onComplete, onProgress }));
      w.start();

      // Let the async prompt resolve
      await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());

      expect(onComplete).toHaveBeenCalledWith('w1', 'Done! Echoed hello.');
      const s = w.getStatus();
      expect(s.state).toBe('complete');
      expect(s.result).toBe('Done! Echoed hello.');
      expect(s.completedAt).toBeDefined();
    });
  });

  describe('start() — error path', () => {
    it('transitions to error state, calls onError', async () => {
      const onError = vi.fn();
      mockPrompt.mockRejectedValueOnce(new Error('LLM failed'));

      const w = new WorkerAgent(makeOpts({ onError }));
      w.start();

      await vi.waitFor(() => expect(onError).toHaveBeenCalled());

      expect(onError).toHaveBeenCalledWith('w1', 'LLM failed');
      const s = w.getStatus();
      expect(s.state).toBe('error');
      expect(s.error).toBe('LLM failed');
    });
  });

  describe('abort()', () => {
    it('sets state to aborted and calls agent.abort()', () => {
      const w = new WorkerAgent(makeOpts());
      w.abort();

      expect(mockAbort).toHaveBeenCalled();
      const s = w.getStatus();
      expect(s.state).toBe('aborted');
      expect(s.completedAt).toBeDefined();
    });

    it('suppresses onComplete after abort', async () => {
      const onComplete = vi.fn();
      mockPrompt.mockResolvedValueOnce(undefined);
      mockState.messages = [assistantMsg('result')];

      const w = new WorkerAgent(makeOpts({ onComplete }));
      w.abort(); // abort before start
      w.start();

      // Give the async chain time to resolve
      await new Promise(r => setTimeout(r, 50));

      expect(onComplete).not.toHaveBeenCalled();
      expect(w.getStatus().state).toBe('aborted');
    });

    it('suppresses onError after abort', async () => {
      const onError = vi.fn();
      mockPrompt.mockRejectedValueOnce(new Error('boom'));

      const w = new WorkerAgent(makeOpts({ onError }));
      w.abort();
      w.start();

      await new Promise(r => setTimeout(r, 50));

      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe('steer()', () => {
    it('delegates to agent.steer()', () => {
      const w = new WorkerAgent(makeOpts());
      w.steer('do something else');

      expect(mockSteer).toHaveBeenCalledWith({
        role: 'user',
        content: 'do something else',
        timestamp: expect.any(Number),
      });
    });
  });

  describe('extractFinalText', () => {
    it('extracts text from last assistant message', async () => {
      const onComplete = vi.fn();
      mockPrompt.mockResolvedValueOnce(undefined);
      mockState.messages = [
        assistantMsg('first'),
        { role: 'user', content: 'follow up' },
        assistantMsg('final answer'),
      ];

      const w = new WorkerAgent(makeOpts({ onComplete }));
      w.start();

      await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(onComplete).toHaveBeenCalledWith('w1', 'final answer');
    });

    it('returns fallback when no assistant messages', async () => {
      const onComplete = vi.fn();
      mockPrompt.mockResolvedValueOnce(undefined);
      mockState.messages = [{ role: 'user', content: 'hello' }];

      const w = new WorkerAgent(makeOpts({ onComplete }));
      w.start();

      await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(onComplete).toHaveBeenCalledWith('w1', 'No output produced.');
    });

    it('joins multiple text blocks', async () => {
      const onComplete = vi.fn();
      mockPrompt.mockResolvedValueOnce(undefined);
      mockState.messages = [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'Part 1.' },
          { type: 'text', text: 'Part 2.' },
        ],
      }];

      const w = new WorkerAgent(makeOpts({ onComplete }));
      w.start();

      await vi.waitFor(() => expect(onComplete).toHaveBeenCalled());
      expect(onComplete).toHaveBeenCalledWith('w1', 'Part 1.\nPart 2.');
    });
  });

  describe('getStatus()', () => {
    it('returns immutable snapshot', () => {
      const w = new WorkerAgent(makeOpts());
      const s1 = w.getStatus();
      w.abort();
      const s2 = w.getStatus();

      expect(s1.state).toBe('starting');
      expect(s2.state).toBe('aborted');
    });

    it('tracks startedAt timestamp', () => {
      const before = Date.now();
      const w = new WorkerAgent(makeOpts());
      const after = Date.now();

      const s = w.getStatus();
      expect(s.startedAt).toBeGreaterThanOrEqual(before);
      expect(s.startedAt).toBeLessThanOrEqual(after);
    });
  });
});
