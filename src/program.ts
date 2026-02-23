/**
 * CrushProgram — the interface for programs that run inside the crush shell.
 *
 * A program receives a ProgramContext with:
 *   - stdout: write to the terminal (raw bytes/ANSI)
 *   - stdin:  async iterable of user keystrokes (each yield is a string chunk)
 *   - args:   command-line arguments (argv[1..])
 *
 * run() returns a Promise<number> — 0 for success, non-zero for error.
 *
 * ## Writing a CrushProgram
 *
 * One-shot programs write to stdout and return immediately:
 *
 *   const myCmd: CrushProgram = {
 *     async run(ctx) {
 *       ctx.stdout('Hello, world!\r\n');
 *       return 0;
 *     },
 *   };
 *
 * Interactive programs read from stdin in a loop:
 *
 *   const chat: CrushProgram = {
 *     async run(ctx) {
 *       ctx.stdout('Type "quit" to exit.\r\n');
 *       for await (const chunk of ctx.stdin) {
 *         if (chunk === 'quit') break;
 *         ctx.stdout(`You typed: ${chunk}\r\n`);
 *       }
 *       return 0;
 *     },
 *   };
 *
 * stdin yields raw keystroke data (same as InputHandler output). For line-
 * buffered input, programs should do their own line editing or use a helper.
 *
 * Future additions (not yet wired):
 *   - chrome: RPC to service worker for CDP/tabs/storage
 *   - scene:  THREE.js scene access for 3D textures, camera, etc.
 */

import type { GhosttyTerminal } from 'ghostty-web';

/** Context provided to a running program */
export interface ProgramContext {
  /** Write data to the terminal (supports ANSI escape sequences) */
  stdout: (data: string) => void;
  /** Async iterable of raw keystroke data from the user */
  stdin: AsyncIterable<string>;
  /** Command-line arguments (everything after the command name) */
  args: string[];
  /** The underlying terminal (for advanced use: resize, mode queries) */
  term: GhosttyTerminal;
}

/** A program that can run inside the crush shell */
export interface CrushProgram {
  /** Run the program. Resolves with exit code (0 = success). */
  run(ctx: ProgramContext): Promise<number>;
}

/**
 * Writable + closable stdin stream.
 *
 * The shell pushes keystrokes via push(). The program consumes them via
 * the async iterator. close() signals EOF (program's for-await loop ends).
 */
export class StdinStream implements AsyncIterable<string> {
  private queue: string[] = [];
  private resolve: ((value: IteratorResult<string>) => void) | null = null;
  private closed = false;

  /** Push keystroke data into the stream (called by the shell) */
  push(data: string): void {
    if (this.closed) return;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: data, done: false });
    } else {
      this.queue.push(data);
    }
  }

  /** Signal EOF — the async iterator will end */
  close(): void {
    this.closed = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as any, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<string>>((resolve) => {
          this.resolve = resolve;
        });
      },
    };
  }
}
