/**
 * LocalShell — provides a basic command-line interface without a real PTY.
 *
 * Sits between the input handler and the terminal emulator:
 *   keyboard → InputHandler → onData → LocalShell → ghosttyTerm.write()
 *
 * Handles line-editing (echo, backspace, cursor movement) and dispatches
 * completed lines to a command handler. When a foreground program is running,
 * keystrokes are routed to the program's stdin instead of the line editor.
 */

import type { GhosttyTerminal } from './ghostty/ghostty';
import type { CrushProgram } from './program';
import { StdinStream } from './program';
import { BUILTIN_COMMANDS } from './commands';

export interface LocalShellOptions {
  term: GhosttyTerminal;
  /** Extra commands to register (merged with built-ins) */
  commands?: Record<string, CrushProgram>;
}

export class LocalShell {
  private term: GhosttyTerminal;
  private commands: Record<string, CrushProgram>;
  private lineBuf = '';

  /** When set, a foreground program is running and keystrokes go to its stdin */
  private fgStdin: StdinStream | null = null;

  constructor(opts: LocalShellOptions) {
    this.term = opts.term;
    this.commands = { ...BUILTIN_COMMANDS, ...opts.commands };
  }

  /** Show the initial banner and first prompt */
  start(): void {
    this.term.write('Welcome to \x1b[1;36mCrush\x1b[0m terminal\r\n');
    this.term.write('Ghostty WASM + Three.js WebGPU SDF rendering\r\n');
    this.term.write('Type \x1b[33mhelp\x1b[0m for available commands.\r\n');
    this.term.write('\r\n');
    this.writePrompt();
  }

  /** Register additional commands at runtime */
  registerCommand(name: string, program: CrushProgram): void {
    this.commands[name] = program;
  }

  /** Feed raw input data (from InputHandler callback) */
  feed(data: string): void {
    // If a foreground program is running, route all input to it
    if (this.fgStdin) {
      this.fgStdin.push(data);
      return;
    }

    for (const ch of data) {
      this.processChar(ch);
    }
  }

  private processChar(ch: string): void {
    const code = ch.charCodeAt(0);

    if (ch === '\r') {
      // Enter — submit line
      this.term.write('\r\n');
      const cmd = this.lineBuf.trim();
      this.lineBuf = '';
      if (cmd.length > 0) {
        this.dispatch(cmd);
      } else {
        this.writePrompt();
      }
    } else if (code === 0x7f || code === 0x08) {
      // Backspace / DEL
      if (this.lineBuf.length > 0) {
        this.lineBuf = this.lineBuf.slice(0, -1);
        this.term.write('\b \b');
      }
    } else if (code === 0x03) {
      // Ctrl+C — cancel line
      this.term.write('^C\r\n');
      this.lineBuf = '';
      this.writePrompt();
    } else if (code === 0x04) {
      // Ctrl+D on empty line — no-op
      if (this.lineBuf.length === 0) {
        this.term.write('\r\n');
        this.writePrompt();
      }
    } else if (code === 0x0c) {
      // Ctrl+L — clear screen
      this.term.write('\x1b[2J\x1b[H');
      this.writePrompt();
      if (this.lineBuf.length > 0) {
        this.term.write(this.lineBuf);
      }
    } else if (code === 0x1b) {
      // Escape sequences (arrows etc.) — swallow for now
    } else if (code >= 0x20) {
      // Printable character — echo and buffer
      this.lineBuf += ch;
      this.term.write(ch);
    }
  }

  private dispatch(cmdLine: string): void {
    const parts = cmdLine.split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1);

    const program = this.commands[name];
    if (!program) {
      this.term.write(`\x1b[31mcrush:\x1b[0m command not found: ${name}\r\n`);
      this.writePrompt();
      return;
    }

    this.runProgram(program, args);
  }

  /** Launch a program in the foreground */
  private runProgram(program: CrushProgram, args: string[]): void {
    const stdin = new StdinStream();
    this.fgStdin = stdin;

    const ctx = {
      stdout: (data: string) => this.term.write(data),
      stdin,
      args,
      term: this.term,
    };

    program
      .run(ctx)
      .then(() => {
        this.fgStdin = null;
        stdin.close();
        this.writePrompt();
      })
      .catch((err) => {
        this.fgStdin = null;
        stdin.close();
        this.term.write(`\x1b[31mcrush: program error:\x1b[0m ${err}\r\n`);
        this.writePrompt();
      });
  }

  private writePrompt(): void {
    this.term.write('\x1b[1;32mcrush\x1b[0m \x1b[34m$\x1b[0m ');
  }
}
