import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LocalShell } from '../src/shell.js';
import type { GhosttyTerminal } from 'ghostty-web';
import type { CrushProgram } from '../src/program.js';

// Mock GhosttyTerminal
function createMockTerm(): GhosttyTerminal {
  return {
    write: vi.fn(),
    // Minimal stub for other methods we don't use
  } as unknown as GhosttyTerminal;
}

describe('LocalShell', () => {
  let term: GhosttyTerminal;
  let shell: LocalShell;

  beforeEach(() => {
    vi.clearAllMocks();
    term = createMockTerm();
    shell = new LocalShell({ term });
  });

  describe('startup', () => {
    it('shows banner on start()', () => {
      shell.start();
      expect(term.write).toHaveBeenCalledWith(expect.stringContaining('Welcome to'));
      expect(term.write).toHaveBeenCalledWith(expect.stringContaining('Crush'));
    });

    it('shows prompt after banner', () => {
      shell.start();
      expect(term.write).toHaveBeenCalledWith(expect.stringContaining('crush'));
      expect(term.write).toHaveBeenCalledWith(expect.stringContaining('$'));
    });
  });

  describe('command dispatch', () => {
    it('runs echo command with args', async () => {
      shell.start();
      vi.mocked(term.write).mockClear();

      // Simulate typing "echo hello world" and pressing Enter
      for (const ch of 'echo hello world') {
        shell.feed(ch);
      }
      shell.feed('\r');

      // Wait for async program to complete
      await new Promise((r) => setTimeout(r, 10));

      expect(term.write).toHaveBeenCalledWith('hello world\r\n');
    });

    it('shows error for unknown command', async () => {
      shell.start();
      vi.mocked(term.write).mockClear();

      for (const ch of 'nonexistent') {
        shell.feed(ch);
      }
      shell.feed('\r');

      await new Promise((r) => setTimeout(r, 10));

      expect(term.write).toHaveBeenCalledWith(
        expect.stringContaining('command not found'),
      );
    });

    it('handles empty line', async () => {
      shell.start();
      vi.mocked(term.write).mockClear();

      shell.feed('\r');

      await new Promise((r) => setTimeout(r, 10));

      // Should just show prompt again, no error
      const calls = vi.mocked(term.write).mock.calls;
      const lastCall = calls[calls.length - 1][0];
      expect(lastCall).toContain('crush');
    });
  });

  describe('line editing', () => {
    it('echoes printable characters', () => {
      shell.feed('a');
      expect(term.write).toHaveBeenCalledWith('a');

      shell.feed('b');
      expect(term.write).toHaveBeenCalledWith('b');
    });

    it('handles backspace', () => {
      shell.feed('a');
      shell.feed('b');
      vi.mocked(term.write).mockClear();

      shell.feed('\x7f'); // DEL

      expect(term.write).toHaveBeenCalledWith('\b \b');
    });

    it('backspace does nothing on empty line', () => {
      vi.mocked(term.write).mockClear();
      shell.feed('\x7f');
      expect(term.write).not.toHaveBeenCalled();
    });

    it('Ctrl+C cancels current line', async () => {
      shell.feed('some input');
      vi.mocked(term.write).mockClear();

      shell.feed('\x03'); // Ctrl+C

      await new Promise((r) => setTimeout(r, 10));

      expect(term.write).toHaveBeenCalledWith('^C\r\n');
      // Line buffer should be cleared
    });
  });

  describe('custom commands', () => {
    it('accepts additional commands at construction', async () => {
      const customCmd: CrushProgram = {
        async run(ctx) {
          ctx.stdout('custom output\r\n');
          return 0;
        },
      };

      shell = new LocalShell({ term, commands: { custom: customCmd } });
      shell.start();
      vi.mocked(term.write).mockClear();

      for (const ch of 'custom') {
        shell.feed(ch);
      }
      shell.feed('\r');

      await new Promise((r) => setTimeout(r, 10));

      expect(term.write).toHaveBeenCalledWith('custom output\r\n');
    });

    it('can register commands at runtime', async () => {
      const lateCmd: CrushProgram = {
        async run(ctx) {
          ctx.stdout('late command\r\n');
          return 0;
        },
      };

      shell.registerCommand('late', lateCmd);
      shell.start();
      vi.mocked(term.write).mockClear();

      for (const ch of 'late') {
        shell.feed(ch);
      }
      shell.feed('\r');

      await new Promise((r) => setTimeout(r, 10));

      expect(term.write).toHaveBeenCalledWith('late command\r\n');
    });
  });

  describe('foreground program input', () => {
    it('routes input to running program', async () => {
      // Program that reads from stdin and echoes
      const interactiveProgram: CrushProgram = {
        async run(ctx) {
          ctx.stdout('Type something: ');
          for await (const chunk of ctx.stdin) {
            ctx.stdout(`You typed: ${chunk}\r\n`);
            break; // Exit after first input
          }
          return 0;
        },
      };

      shell = new LocalShell({ term, commands: { interact: interactiveProgram } });
      shell.start();
      vi.mocked(term.write).mockClear();

      // Start the interactive program
      for (const ch of 'interact') {
        shell.feed(ch);
      }
      shell.feed('\r');

      await new Promise((r) => setTimeout(r, 5));

      // Send input while program is running
      // Note: feed sends individual characters, stdin receives them character-by-character
      shell.feed('h'); // Program will receive 'h' as the first chunk

      await new Promise((r) => setTimeout(r, 20));

      expect(term.write).toHaveBeenCalledWith(expect.stringContaining('Type something'));
      expect(term.write).toHaveBeenCalledWith('You typed: h\r\n');
    });
  });
});
