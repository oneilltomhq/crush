/**
 * LocalShell — provides a basic command-line interface without a real PTY.
 */

import type { GhosttyTerminal } from 'ghostty-web';
import type { CrushProgram, ProgramContext } from './program';
import { StdinStream } from './program';
import { BUILTIN_COMMANDS } from './commands';
import { agentCmd } from './agent';
import { rpc } from './chrome-rpc';
import { getMotd } from './motd';
import type { WorkspaceFS } from './fs';
import { resolve, toRelative } from './path';
import type { Scene } from 'three';


export interface LocalShellOptions {
  term: GhosttyTerminal;
  scene: Scene;
  chrome: typeof rpc;
  fs: WorkspaceFS;
  commands?: Record<string, CrushProgram>;
}

export class LocalShell {
  private term: GhosttyTerminal;
  private scene: Scene;
  private chrome: typeof rpc;
  private fs: WorkspaceFS;
  private commands: Record<string, CrushProgram>;
  private lineBuf = '';
  private cwd = '/';
  private fgStdin: StdinStream | null = null;
  private fgAbortController: AbortController | null = null;

  constructor(opts: LocalShellOptions) {
    this.term = opts.term;
    this.scene = opts.scene;
    this.chrome = opts.chrome;
    this.fs = opts.fs;
    this.commands = { ...BUILTIN_COMMANDS, agent: agentCmd, ...opts.commands };
  }

  start(): void {
    this.term.write(getMotd());
    this.writePrompt();
  }

  feed(data: string): void {
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
      this.term.write('\r\n');
      const cmd = this.lineBuf.trim();
      this.lineBuf = '';
      if (cmd.length > 0) {
        this.dispatch(cmd);
      } else {
        this.writePrompt();
      }
    } else if (code === 0x7f || code === 0x08) {
      if (this.lineBuf.length > 0) {
        this.lineBuf = this.lineBuf.slice(0, -1);
        this.term.write('\b \b');
      }
    } else if (code === 0x03) {
      if (this.fgStdin && this.fgAbortController) {
        this.fgAbortController.abort();
        this.term.write('^C\r\n');
      } else {
        this.term.write('^C\r\n');
        this.lineBuf = '';
        this.writePrompt();
      }
    } else if (code >= 0x20) {
      if (this.lineBuf.length === 0) {
        this.term.write('\x1b[?25l');
      }
      this.lineBuf += ch;
      this.term.write(ch);
    }
  }

  private async dispatch(cmdLine: string): Promise<void> {
    const parts = cmdLine.split(/\s+/);
    const name = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (name === 'cd') {
      await this.handleCd(args);
      this.writePrompt();
      return;
    }

    const program = this.commands[name];
    if (!program) {
      this.term.write(`\x1b[31mcrush:\x1b[0m command not found: ${name}\r\n`);
      const suggestion = this.findClosestCommand(name);
      if (suggestion) {
        this.term.write(`Did you mean '\x1b[33m${suggestion}\x1b[0m'?\r\n`);
      }
      this.writePrompt();
      return;
    }

    this.runProgram(program, args);
  }

  private async handleCd(args: string[]): Promise<void> {
      const targetPath = args[0] || '/';
      const newPath = resolve(this.cwd, targetPath);
      const stat = await this.fs.stat(toRelative(newPath));

      if (stat && stat.kind === 'directory') {
          this.cwd = newPath;
      } else if (stat) {
          this.term.write(`\x1b[31mcd: not a directory: ${newPath}\x1b[0m\r\n`);
      } else {
          this.term.write(`\x1b[31mcd: path not found: ${newPath}\x1b[0m\r\n`);
      }
  }

  private findClosestCommand(cmd: string): string | null {
    let bestMatch: string | null = null;
    let minDistance = 3;

    for (const knownCmd of Object.keys(this.commands)) {
      const distance = this.levenshtein(cmd, knownCmd);
      if (distance < minDistance) {
        minDistance = distance;
        bestMatch = knownCmd;
      }
    }
    return bestMatch;
  }

  private levenshtein = (a: string, b: string): number => {
    const matrix = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + cost,
        );
      }
    }
    return matrix[a.length][b.length];
  };

  private runProgram(program: CrushProgram, args: string[]): void {
    const stdin = new StdinStream();
    const abortController = new AbortController();
    this.fgStdin = stdin;
    this.fgAbortController = abortController;

    const ctx: ProgramContext = {
      stdout: (data: string) => this.term.write(data),
      stderr: (data: string) => this.term.write(`\x1b[31m${data}\x1b[0m`),
      stdin,
      args,
      term: this.term,
      scene: this.scene,
      abortSignal: abortController.signal,
      chrome: this.chrome,
      fs: this.fs,
      cwd: this.cwd,
    };

    program
      .run(ctx)
      .then(() => {
        this.fgStdin = null;
        this.fgAbortController = null;
        stdin.close();
        this.writePrompt();
      })
      .catch((err) => {
        this.fgStdin = null;
        this.fgAbortController = null;
        stdin.close();
        if (err?.name !== 'AbortError') {
          this.term.write(`\x1b[31mcrush: program error:\x1b[0m ${err.message}\r\n`);
        }
        this.writePrompt();
      });
  }

  private writePrompt(): void {
    const path = this.cwd === '/' ? '~' : this.cwd;
    this.term.write(`\x1b[?25h\x1b[1;32mcrush\x1b[0m:\x1b[1;34m${path}\x1b[0m \x1b[34m$\x1b[0m `);
  }
}
