import { describe, it, expect, vi, beforeEach } from 'vitest';
import { send, extractText, notifyFoh } from './agent-helpers.js';

// ---------------------------------------------------------------------------
// send()
// ---------------------------------------------------------------------------

describe('send()', () => {
  it('sends JSON when ws is open (readyState=1)', () => {
    const mockSend = vi.fn();
    const ws = { readyState: 1, send: mockSend } as any;
    send(ws, { type: 'test', data: 42 });
    expect(mockSend).toHaveBeenCalledWith('{"type":"test","data":42}');
  });

  it('does not send when ws is closed (readyState=3)', () => {
    const mockSend = vi.fn();
    const ws = { readyState: 3, send: mockSend } as any;
    send(ws, { type: 'test' });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('does not send when ws is connecting (readyState=0)', () => {
    const mockSend = vi.fn();
    const ws = { readyState: 0, send: mockSend } as any;
    send(ws, { type: 'test' });
    expect(mockSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// extractText()
// ---------------------------------------------------------------------------

describe('extractText()', () => {
  it('extracts text from assistant message', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello world' }],
    };
    expect(extractText(msg)).toBe('Hello world');
  });

  it('joins multiple text blocks with space', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Part one.' },
        { type: 'text', text: 'Part two.' },
      ],
    };
    expect(extractText(msg)).toBe('Part one. Part two.');
  });

  it('ignores non-text blocks (tool_use, etc.)', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't1', name: 'foo', input: {} },
        { type: 'text', text: 'Spoken part' },
      ],
    };
    expect(extractText(msg)).toBe('Spoken part');
  });

  it('returns empty string for non-assistant messages', () => {
    expect(extractText({ role: 'user', content: [{ type: 'text', text: 'hi' }] })).toBe('');
    expect(extractText({ role: 'tool', content: [{ type: 'text', text: 'result' }] })).toBe('');
  });

  it('trims whitespace', () => {
    const msg = {
      role: 'assistant',
      content: [{ type: 'text', text: '  hello  ' }],
    };
    expect(extractText(msg)).toBe('hello');
  });

  it('handles empty content array', () => {
    const msg = { role: 'assistant', content: [] };
    expect(extractText(msg)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// notifyFoh()
// ---------------------------------------------------------------------------

describe('notifyFoh()', () => {
  function makeConn(overrides: Partial<{
    processing: boolean;
    agentPrompt: ReturnType<typeof vi.fn>;
    agentSteer: ReturnType<typeof vi.fn>;
    agentMessages: any[];
    wsSend: ReturnType<typeof vi.fn>;
  }> = {}) {
    const wsSend = overrides.wsSend ?? vi.fn();
    const agentPrompt = overrides.agentPrompt ?? vi.fn().mockResolvedValue(undefined);
    const agentSteer = overrides.agentSteer ?? vi.fn();
    const agentMessages = overrides.agentMessages ?? [];
    return {
      conn: {
        ws: { readyState: 1, send: wsSend } as any,
        id: 'test',
        agent: {
          prompt: agentPrompt,
          steer: agentSteer,
          state: { messages: agentMessages },
        },
        processing: overrides.processing ?? false,
      },
      wsSend,
      agentPrompt,
      agentSteer,
    };
  }

  describe('idle path (processing=false)', () => {
    it('calls prompt() and sends response', async () => {
      const { conn, wsSend, agentPrompt } = makeConn({
        agentMessages: [
          { role: 'assistant', content: [{ type: 'text', text: 'Your task is done!' }] },
        ],
      });

      await notifyFoh(conn, 'Worker w1 finished.');

      expect(agentPrompt).toHaveBeenCalledWith(
        expect.stringContaining('Worker w1 finished.')
      );
      // Should send thinking + response
      expect(wsSend).toHaveBeenCalledTimes(2);
      const calls = wsSend.mock.calls.map((c: any) => JSON.parse(c[0]));
      expect(calls[0]).toEqual({ type: 'thinking' });
      expect(calls[1]).toEqual({ type: 'response', text: 'Your task is done!' });
    });

    it('sets processing=true during prompt, resets after', async () => {
      const { conn } = makeConn({
        agentMessages: [
          { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
        ],
      });

      expect(conn.processing).toBe(false);
      await notifyFoh(conn, 'done');
      expect(conn.processing).toBe(false); // reset in finally
    });

    it('resets processing even on error', async () => {
      const { conn } = makeConn({
        agentPrompt: vi.fn().mockRejectedValue(new Error('LLM down')),
      });

      await notifyFoh(conn, 'test');
      expect(conn.processing).toBe(false);
    });

    it('handles empty response gracefully', async () => {
      const { conn, wsSend } = makeConn({
        agentMessages: [], // no assistant messages
      });

      await notifyFoh(conn, 'test');
      // Should send thinking but no response (no spoken text)
      const calls = wsSend.mock.calls.map((c: any) => JSON.parse(c[0]));
      expect(calls).toEqual([{ type: 'thinking' }]);
    });
  });

  describe('busy path (processing=true)', () => {
    it('calls steer() instead of prompt()', async () => {
      const { conn, agentPrompt, agentSteer } = makeConn({
        processing: true,
      });

      await notifyFoh(conn, 'Worker w1 finished.');

      expect(agentSteer).toHaveBeenCalledWith({
        role: 'user',
        content: expect.stringContaining('Worker w1 finished.'),
        timestamp: expect.any(Number),
      });
      expect(agentPrompt).not.toHaveBeenCalled();
    });

    it('does not change processing flag', async () => {
      const { conn } = makeConn({ processing: true });

      await notifyFoh(conn, 'test');
      expect(conn.processing).toBe(true); // unchanged
    });

    it('does not send any WS messages', async () => {
      const { conn, wsSend } = makeConn({ processing: true });

      await notifyFoh(conn, 'test');
      expect(wsSend).not.toHaveBeenCalled();
    });
  });

  describe('notification format', () => {
    it('wraps notification in system-style prefix', async () => {
      const { conn, agentPrompt } = makeConn({
        agentMessages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
      });

      await notifyFoh(conn, 'Worker w1 finished.');

      const promptArg = agentPrompt.mock.calls[0][0];
      expect(promptArg).toContain('[Worker notification');
      expect(promptArg).toContain('tell the user immediately');
      expect(promptArg).toContain('Worker w1 finished.');
    });
  });
});
