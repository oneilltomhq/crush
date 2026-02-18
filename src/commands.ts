/**
 * Built-in crush commands, each implemented as a CrushProgram.
 */

import type { CrushProgram } from './program';

export const helpCmd: CrushProgram = {
  async run(ctx) {
    ctx.stdout(
      [
        '\x1b[1mAvailable commands:\x1b[0m',
        '  \x1b[33mhelp\x1b[0m          Show this message',
        '  \x1b[33mecho\x1b[0m [text]   Print text',
        '  \x1b[33mclear\x1b[0m         Clear screen',
        '  \x1b[33mcolors\x1b[0m        Show color palette',
        '  \x1b[33mdate\x1b[0m          Show current date/time',
        '',
        'This is a local terminal — no PTY backend yet.',
        'Connect a WebSocket PTY server for a real shell.',
      ].join('\r\n') + '\r\n',
    );
    return 0;
  },
};

export const echoCmd: CrushProgram = {
  async run(ctx) {
    ctx.stdout(ctx.args.join(' ') + '\r\n');
    return 0;
  },
};

export const clearCmd: CrushProgram = {
  async run(ctx) {
    ctx.stdout('\x1b[2J\x1b[H');
    return 0;
  },
};

export const colorsCmd: CrushProgram = {
  async run(ctx) {
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
    ctx.stdout(lines.join('\r\n') + '\r\n');
    return 0;
  },
};

export const dateCmd: CrushProgram = {
  async run(ctx) {
    ctx.stdout(new Date().toString() + '\r\n');
    return 0;
  },
};

/** Registry of built-in commands */
export const BUILTIN_COMMANDS: Record<string, CrushProgram> = {
  help: helpCmd,
  echo: echoCmd,
  clear: clearCmd,
  colors: colorsCmd,
  date: dateCmd,
};
