/**
 * Built-in crush commands, each implemented as a CrushProgram.
 */

import type { CrushProgram, ProgramContext } from './program';
import { cdpEventBus } from './events';
import { updateScreenshotTexture } from './renderer';
import * as anthropic from './anthropic';
import { resolve, toRelative } from './path';

function createCdpCommand(cmd: (ctx: ProgramContext) => Promise<any>): CrushProgram {
  return {
    async run(ctx: ProgramContext) {
      try {
        await cmd(ctx);
        return 0;
      } catch (e: any) {
        ctx.stderr(`Error: ${e.message}\r\n`);
        return 1;
      }
    },
  };
}

// Helper to wait for a CDP event with a timeout
function waitForCdpEvent(eventName: string, timeoutMs = 5000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cdpEventBus.off(eventName, listener);
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeoutMs);

    const listener = (params: any) => {
      clearTimeout(timeout);
      resolve(params);
    };

    cdpEventBus.once(eventName, listener);
  });
}

export const helpCmd: CrushProgram = {
  async run(ctx) {
    ctx.stdout(
      [
        '\x1b[1mBuilt-in commands:\x1b[0m',
        '  \x1b[33mhelp\x1b[0m          Show this message',
        '  \x1b[33mecho\x1b[0m [text]   Print text',
        '  \x1b[33mclear\x1b[0m         Clear screen',
        '  \x1b[33mcolors\x1b[0m        Show color palette',
        '  \x1b[33mdate\x1b[0m          Show current date/time',
        '',
        '\x1b[1mFilesystem:\x1b[0m',
        '  \x1b[33mpwd\x1b[0m           Print current working directory',
        '  \x1b[33mcd\x1b[0m <path>       Change current working directory',
        '  \x1b[33mls\x1b[0m [path]      List directory contents',
        '  \x1b[33mcat\x1b[0m <path>     Print file contents',
        '  \x1b[33mmkdir\x1b[0m <path>    Create a directory',
        '  \x1b[33mrm\x1b[0m <path>       Remove a file or directory',
        '',
        '\x1b[1mBrowser control:\x1b[0m',
        '  \x1b[33mattach\x1b[0m        Attach to the active tab',
        '  \x1b[33mdetach\x1b[0m        Detach from the tab',
        '  \x1b[33mnavigate\x1b[0m <url>  Navigate the tab to a URL',
        '  \x1b[33mclick\x1b[0m <sel>    Click on an element',
        '  \x1b[33mtype\x1b[0m <text>   Type text into the focused element',
        '  \x1b[33mscreenshot\x1b[0m   Capture a screenshot',
        '  \x1b[33mevaluate\x1b[0m <js>   Evaluate JavaScript in the tab',
        '  \x1b[33mscroll\x1b[0m <dx> <dy> Scroll the page',
        '  \x1b[33mhover\x1b[0m <sel>    Hover over an element',
        '  \x1b[33mselect\x1b[0m <sel> <val> Set a dropdown value',
        '',
        '\x1b[1mAgent:\x1b[0m',
        '  \x1b[33magent\x1b[0m <goal>   Run an agent to achieve a goal',
        '  \x1b[33mset-key\x1b[0m <svc> <key> Set an API key for a service (e.g., anthropic)',
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

export const pwdCmd: CrushProgram = {
    async run(ctx) {
        ctx.stdout(ctx.cwd + '\r\n');
        return 0;
    }
};

export const lsCmd: CrushProgram = {
    async run(ctx) {
        const targetPath = ctx.args[0] || '.';
        const absolutePath = resolve(ctx.cwd, targetPath);
        try {
            const entries = await ctx.fs.list(toRelative(absolutePath));
            if (entries.length === 0) {
                return 0;
            }
            const output = entries.map(e => {
                if (e.kind === 'directory') {
                    return `\x1b[1;34m${e.name}/\x1b[0m`;
                }
                return e.name;
            }).join('  ');
            ctx.stdout(output + '\r\n');
            return 0;
        } catch (e: any) {
            ctx.stderr(`ls: ${e.message}\r\n`);
            return 1;
        }
    }
};

export const catCmd: CrushProgram = {
    async run(ctx) {
        const targetPath = ctx.args[0];
        if (!targetPath) {
            ctx.stderr('Usage: cat <path>\r\n');
            return 1;
        }
        const absolutePath = resolve(ctx.cwd, targetPath);
        try {
            const content = await ctx.fs.readText(toRelative(absolutePath));
            ctx.stdout(content.replace(/\n/g, '\r\n') + '\r\n');
            return 0;
        } catch (e: any) {
            ctx.stderr(`cat: ${e.message}\r\n`);
            return 1;
        }
    }
};

export const mkdirCmd: CrushProgram = {
    async run(ctx) {
        const targetPath = ctx.args[0];
        if (!targetPath) {
            ctx.stderr('Usage: mkdir <path>\r\n');
            return 1;
        }
        const absolutePath = resolve(ctx.cwd, targetPath);
        try {
            await ctx.fs.mkdirp(toRelative(absolutePath));
            return 0;
        } catch (e: any) {
            ctx.stderr(`mkdir: ${e.message}\r\n`);
            return 1;
        }
    }
};

export const rmCmd: CrushProgram = {
    async run(ctx) {
        const targetPath = ctx.args[0];
        if (!targetPath) {
            ctx.stderr('Usage: rm <path>\r\n');
            return 1;
        }
        const absolutePath = resolve(ctx.cwd, targetPath);
        try {
            await ctx.fs.remove(toRelative(absolutePath));
            return 0;
        } catch (e: any) {
            ctx.stderr(`rm: ${e.message}\r\n`);
            return 1;
        }
    }
};


export const attachCmd: CrushProgram = createCdpCommand(async (ctx) => {
  const tabs = await ctx.chrome('tabs.query', { active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) {
    throw new Error('No active tab found');
  }
  const tabId = tabs[0].id;
  await ctx.chrome('debugger.attach', { tabId }, '1.3');
  ctx.stdout('Attached to active tab.\r\n');
});

export const detachCmd: CrushProgram = createCdpCommand(async (ctx) => {
  await ctx.chrome('debugger.detach');
  ctx.stdout('Detached from tab.\r\n');
});

export const navigateCmd: CrushProgram = createCdpCommand(async (ctx) => {
  const url = ctx.args[0];
  if (!url) {
    throw new Error('Usage: navigate <url>');
  }
  ctx.stdout(`Navigating to ${url}...\r\n`);

  const navPromise = ctx.chrome('debugger.sendCommand', 'Page.navigate', { url });
  const loadPromise = waitForCdpEvent('Page.loadEventFired');

  await Promise.all([navPromise, loadPromise]);

  ctx.stdout('Page loaded.\r\n');
});


export const clickCmd: CrushProgram = createCdpCommand(async (ctx) => {
  const selector = ctx.args.join(' ');
  if (!selector) {
    throw new Error('Usage: click <selector>');
  }

  const expression = `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) {
      throw new Error('Element not found');
    }
    const rect = el.getBoundingClientRect();
    JSON.stringify({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  `;

  const { result } = await ctx.chrome('debugger.sendCommand', 'Runtime.evaluate', { expression, returnByValue: true });

  if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description || result.result.value;
      throw new Error(desc.replace(/^Error: /, ''));
  }

  const { x, y } = JSON.parse(result.result.value);

  await ctx.chrome('debugger.sendCommand', 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1,
  });
  await ctx.chrome('debugger.sendCommand', 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1,
  });

  ctx.stdout(`Clicked on ${selector}\r\n`);
});

export const typeCmd: CrushProgram = createCdpCommand(async (ctx) => {
  if (ctx.args.length === 0) {
    throw new Error('Usage: type <text>');
  }
  
  // Re-join args and then process, to handle spaces inside quoted strings correctly
  const text = ctx.args.join(' ');

  // This regex finds either a special key like {enter} or a block of plain text.
  const parts = text.match(/({[^}]+})|([^{]+)/g) || [];

  for (const part of parts) {
    const key = part.toLowerCase();
    if (key === '{enter}') {
      await ctx.chrome('debugger.sendCommand', 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r',
      });
      await ctx.chrome('debugger.sendCommand', 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      });
    } else if (key === '{tab}') {
      await ctx.chrome('debugger.sendCommand', 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
      });
      await ctx.chrome('debugger.sendCommand', 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9,
      });
    } else if (part) { // Ensure part is not an empty string
      await ctx.chrome('debugger.sendCommand', 'Input.insertText', { text: part });
    }
  }
  ctx.stdout(`Typed: ${text}\r\n`);
});

export const screenshotCmd: CrushProgram = createCdpCommand(async (ctx) => {
  const { data } = await ctx.chrome('debugger.sendCommand', 'Page.captureScreenshot', {});
  updateScreenshotTexture(data);
  ctx.stdout(`Screenshot captured and displayed in scene.\r\n`);
});

export const evaluateCmd: CrushProgram = createCdpCommand(async (ctx) => {
  const expression = ctx.args.join(' ');
  if (!expression) {
    throw new Error('Usage: evaluate <expression>');
  }

  const { result, exceptionDetails } = await ctx.chrome('debugger.sendCommand', 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  if (exceptionDetails) {
    const err = exceptionDetails.exception;
    if (err) {
      throw new Error(err.description || `Evaluation failed: ${err.value}`);
    } else {
      throw new Error('Evaluation failed with an unknown exception.');
    }
  }

  const output = result.value;
  ctx.stdout(JSON.stringify(output, null, 2) + '\r\n');
});

export const scrollCmd: CrushProgram = createCdpCommand(async (ctx) => {
  const [deltaX, deltaY] = ctx.args.map(Number);
  if (isNaN(deltaX) || isNaN(deltaY)) {
    throw new Error('Usage: scroll <deltaX> <deltaY>');
  }

  await ctx.chrome('debugger.sendCommand', 'Input.dispatchMouseEvent', {
    type: 'mouseWheel', x: 100, y: 100, deltaX, deltaY,
  });

  ctx.stdout(`Scrolled by ${deltaX}, ${deltaY}\r\n`);
});

export const hoverCmd: CrushProgram = createCdpCommand(async (ctx) => {
  const selector = ctx.args.join(' ');
  if (!selector) {
    throw new Error('Usage: hover <selector>');
  }

  const expression = `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) {
      throw new Error('Element not found');
    }
    const rect = el.getBoundingClientRect();
    JSON.stringify({
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    });
  `;

  const { result } = await ctx.chrome('debugger.sendCommand', 'Runtime.evaluate', { expression, returnByValue: true });

  if (result.exceptionDetails) {
      const desc = result.exceptionDetails.exception?.description || result.result.value;
      throw new Error(desc.replace(/^Error: /, ''));
  }

  const { x, y } = JSON.parse(result.result.value);
  await ctx.chrome('debugger.sendCommand', 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  ctx.stdout(`Hovered over ${selector}\r\n`);
});

export const selectCmd: CrushProgram = createCdpCommand(async (ctx) => {
  const [selector, value] = ctx.args;
  if (!selector || value === undefined) {
    throw new Error('Usage: select <selector> <value>');
  }

  const expression = `
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) throw new Error('Element not found');
    if (el.tagName !== 'SELECT') throw new Error('Element is not a <select> element');
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('change', { bubbles: true }));
    'OK';
  `;

  const { result } = await ctx.chrome('debugger.sendCommand', 'Runtime.evaluate', { expression });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception.description);

  ctx.stdout(`Set value of ${selector} to "${value}"\r\n`);
});

export const setKeyCmd: CrushProgram = {
    async run(ctx) {
        const [service, key] = ctx.args;
        if (!service || !key) {
            ctx.stderr('Usage: set-key <service> <key>\r\n');
            return 1;
        }

        if (service.toLowerCase() === 'anthropic') {
            await anthropic.setApiKey(key);
            ctx.stdout('Anthropic API key set.\r\n');
            return 0;
        } else {
            ctx.stderr(`Unknown service: ${service}\r\n`);
            return 1;
        }
    }
};

/** Registry of built-in commands */
export const BUILTIN_COMMANDS: Record<string, CrushProgram> = {
  help: helpCmd,
  echo: echoCmd,
  clear: clearCmd,
  colors: colorsCmd,
  date: dateCmd,
  pwd: pwdCmd,
  ls: lsCmd,
  cat: catCmd,
  mkdir: mkdirCmd,
  rm: rmCmd,
  attach: attachCmd,
  detach: detachCmd,
  navigate: navigateCmd,
  click: clickCmd,
  type: typeCmd,
  screenshot: screenshotCmd,
  evaluate: evaluateCmd,
  scroll: scrollCmd,
  hover: hoverCmd,
  select: selectCmd,
  'set-key': setKeyCmd,
};
