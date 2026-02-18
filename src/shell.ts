/**
 * LocalShell — provides a basic command-line interface without a real PTY.
 *
 * Sits between the input handler and the terminal emulator:
 *   keyboard → InputHandler → onData → LocalShell → ghosttyTerm.write()
 *
 * Handles line-editing (echo, backspace, cursor movement) and dispatches
 * completed lines to a command handler. Replace with a WebSocket PTY
 * bridge when a real shell backend is available.
 */

import type { GhosttyTerminal } from './ghostty/ghostty';

export interface LocalShellOptions {
  term: GhosttyTerminal;
  /** Optional command handler. Return output string (may include ANSI). */
  onCommand?: (cmd: string) => string | null;
}

export class LocalShell {
  private term: GhosttyTerminal;
  private onCommand: (cmd: string) => string | null;
  private lineBuf = '';

  constructor(opts: LocalShellOptions) {
    this.term = opts.term;
    this.onCommand = opts.onCommand ?? defaultCommandHandler;
  }

  /** Show the initial banner and first prompt */
  start(): void {
    this.term.write('Welcome to \x1b[1;36mCrush\x1b[0m terminal\r\n');
    this.term.write('Ghostty WASM + Three.js WebGPU SDF rendering\r\n');
    this.term.write('Type \x1b[33mhelp\x1b[0m for available commands.\r\n');
    this.term.write('\r\n');
    this.writePrompt();
  }

  /** Feed raw input data (from InputHandler callback) */
  feed(data: string): void {
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
        const output = this.onCommand(cmd);
        if (output !== null) {
          this.term.write(output);
          if (!output.endsWith('\n')) this.term.write('\r\n');
        }
      }
      this.writePrompt();
    } else if (code === 0x7f || code === 0x08) {
      // Backspace / DEL
      if (this.lineBuf.length > 0) {
        this.lineBuf = this.lineBuf.slice(0, -1);
        // Move cursor back, overwrite with space, move back again
        this.term.write('\b \b');
      }
    } else if (code === 0x03) {
      // Ctrl+C — cancel line
      this.term.write('^C\r\n');
      this.lineBuf = '';
      this.writePrompt();
    } else if (code === 0x04) {
      // Ctrl+D on empty line — no-op (no real shell to exit)
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
      // Multi-byte sequences will come as separate chars from the encoder
    } else if (code >= 0x20) {
      // Printable character — echo and buffer
      this.lineBuf += ch;
      this.term.write(ch);
    }
  }

  private writePrompt(): void {
    this.term.write('\x1b[1;32mcrush\x1b[0m \x1b[34m$\x1b[0m ');
  }
}

function defaultCommandHandler(cmd: string): string | null {
  const parts = cmd.split(/\s+/);
  const name = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (name) {
    case 'help':
      return [
        '\x1b[1mAvailable commands:\x1b[0m',
        '  \x1b[33mhelp\x1b[0m          Show this message',
        '  \x1b[33mecho\x1b[0m [text]   Print text',
        '  \x1b[33mclear\x1b[0m         Clear screen',
        '  \x1b[33mcolors\x1b[0m        Show color palette',
        '  \x1b[33mdate\x1b[0m          Show current date/time',
        '',
        'This is a local terminal — no PTY backend yet.',
        'Connect a WebSocket PTY server for a real shell.',
      ].join('\r\n');

    case 'echo':
      return args.join(' ');

    case 'clear':
      return '\x1b[2J\x1b[H';

    case 'colors': {
      const lines: string[] = ['Standard colors:'];
      let row = '';
      for (let i = 0; i < 8; i++) row += `\x1b[4${i}m  \x1b[0m`;
      lines.push(row);
      row = '';
      for (let i = 0; i < 8; i++) row += `\x1b[10${i}m  \x1b[0m`;
      lines.push(row);
      lines.push('');
      lines.push('Foreground:');
      row = '';
      for (let i = 0; i < 8; i++) row += `\x1b[3${i}m█\x1b[0m`;
      row += ' ';
      for (let i = 0; i < 8; i++) row += `\x1b[1;3${i}m█\x1b[0m`;
      lines.push(row);
      return lines.join('\r\n');
    }

    case 'date':
      return new Date().toString();

    default:
      return `\x1b[31mcrush:\x1b[0m command not found: ${name}`;
  }
}
