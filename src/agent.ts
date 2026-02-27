/**
 * Contains the core logic for the Crush agent, including tool definitions
 * and the main agent loop.
 */

import type { CrushProgram, ProgramContext } from './program';
import * as anthropic from './anthropic';
import { navigateCmd, clickCmd, typeCmd, screenshotCmd, scrollCmd, selectCmd } from './commands';

// Based on Anthropic's tool-use format
export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
    }>;
    required?: string[];
  };
  // The actual implementation that gets called by the agent
  execute: (ctx: ProgramContext, args: any) => Promise<string>;
}

async function executeAndCapture(ctx: ProgramContext, program: CrushProgram, args: string[]): Promise<string> {
  let output = '';
  // The agent's context has stderr pointing to stdout, so we can capture everything here.
  const cmdCtx: ProgramContext = { ...ctx, stdout: (data) => output += data, stderr: (data) => output += data, args };
  await program.run(cmdCtx);
  return output.trim();
}

/** A promise-based sleep that can be aborted. */
function sleep(ms: number, signal: AbortSignal) {
    return new Promise((resolve, reject) => {
        if (signal.aborted) {
            return reject(new DOMException('Aborted', 'AbortError'));
        }
        const timeout = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timeout);
            reject(new DOMException('Aborted', 'AbortError'));
        });
    });
}

export const BROWSER_TOOLS: Tool[] = [
  {
    name: 'navigate',
    description: 'Navigate the browser to a specific URL.',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The absolute URL to navigate to (e.g., "https://www.google.com").',
        },
      },
      required: ['url'],
    },
    async execute(ctx, args) {
      return executeAndCapture(ctx, navigateCmd, [args.url]);
    },
  },
  {
    name: 'click',
    description: 'Click on a DOM element specified by a CSS selector.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'The CSS selector of the element to click.',
        },
      },
      required: ['selector'],
    },
    async execute(ctx, args) {
      return executeAndCapture(ctx, clickCmd, [args.selector]);
    },
  },
  {
    name: 'type',
    description: 'Type text into the currently focused element. Can also be used to press special keys like {Enter} or {Tab}.',
    input_schema: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'The text to type. To press Enter, use "{Enter}". To press Tab, use "{Tab}".',
        },
      },
      required: ['text'],
    },
    async execute(ctx, args) {
      return executeAndCapture(ctx, typeCmd, [args.text]);
    },
  },
    {
    name: 'scroll',
    description: 'Scroll the page by a given amount.',
    input_schema: {
      type: 'object',
      properties: {
        deltaX: {
          type: 'number',
          description: 'The amount to scroll horizontally. Positive values scroll right.',
        },
        deltaY: {
          type: 'number',
          description: 'The amount to scroll vertically. Positive values scroll down.',
        },
      },
      required: ['deltaX', 'deltaY'],
    },
    async execute(ctx, args) {
      return executeAndCapture(ctx, scrollCmd, [String(args.deltaX), String(args.deltaY)]);
    },
  },
  {
    name: 'select',
    description: 'Set the value of a <select> dropdown element.',
    input_schema: {
      type: 'object',
      properties: {
        selector: {
          type: 'string',
          description: 'The CSS selector of the <select> element.',
        },
        value: {
          type: 'string',
          description: 'The value to select.',
        },
      },
      required: ['selector', 'value'],
    },
    async execute(ctx, args) {
      return executeAndCapture(ctx, selectCmd, [args.selector, args.value]);
    },
  },
  {
    name: 'finish',
    description: 'Use this tool to indicate you have successfully completed the user\'s goal.',
    input_schema: {
        type: 'object',
        properties: {
            summary: {
                type: 'string',
                description: 'A brief summary of what you accomplished.'
            }
        },
        required: ['summary'],
    },
    async execute(ctx, args) {
        return `Goal achieved: ${args.summary}`;
    }
  }
];

const MAX_STEPS = 10;

export const agentCmd: CrushProgram = {
  async run(ctx: ProgramContext) {
    const goal = ctx.args.join(' ');
    if (!goal) {
        ctx.stderr('Usage: agent <goal>\r\n');
        return 1;
    }

    const agentCtx = { ...ctx, stderr: ctx.stdout }; // Redirect agent stderr to stdout for narration
    
    agentCtx.stdout(`\x1b[1;34mGoal:\x1b[0m ${goal}\r\n`);

    const history: anthropic.AnthropicMessage[] = [{
        role: 'user',
        content: [{ type: 'text', text: `Here is my goal: ${goal}` }],
    }];

    for (let i = 0; i < MAX_STEPS; i++) {
        if (agentCtx.abortSignal.aborted) {
            agentCtx.stdout('\r\nAgent interrupted.\r\n');
            return 1;
        }

        const step = i + 1;
        agentCtx.stdout(`\x1b[1;32mStep ${step}/${MAX_STEPS}:\x1b[0m Thinking...\r\n`);
        
        let response: anthropic.AnthropicMessagesResponse;
        try {
            response = await anthropic.getNextAction(history, BROWSER_TOOLS);
        } catch (e: any) {
            agentCtx.stderr(`\x1b[31mError:\x1b[0m ${e.message}\r\n`);
            return 1;
        }

        // Add the model's response to history
        history.push({ role: 'assistant', content: response.content });

        const toolUseContent = response.content.find(c => c.type === 'tool_use') as anthropic.AnthropicToolUseContent | undefined;
        const textContent = response.content.find(c => c.type === 'text') as anthropic.AnthropicTextContent | undefined;

        if (textContent) {
            agentCtx.stdout(`\x1b[36mThought:\x1b[0m ${textContent.text}\r\n`);
        }
        
        if (!toolUseContent) {
            agentCtx.stdout('No tool chosen. Agent is finishing.\r\n');
            return 0;
        }
        
        const tool = BROWSER_TOOLS.find(t => t.name === toolUseContent.name);
        if (!tool) {
            agentCtx.stderr(`Agent tried to use a non-existent tool: ${toolUseContent.name}`);
            return 1;
        }
        
        agentCtx.stdout(`\x1b[1;33mAction:\x1b[0m ${tool.description}\r\n`);
        const result = await tool.execute(agentCtx, toolUseContent.input);
        agentCtx.stdout(`\x1b[2m> ${tool.name}(${JSON.stringify(toolUseContent.input)}) → ${result || 'OK'}\x1b[0m\r\n`);

        history.push({
            role: 'user',
            content: [{
                type: 'tool_result',
                tool_use_id: toolUseContent.id,
                content: result,
            }]
        });

        if (tool.name === 'finish') {
            agentCtx.stdout(`\x1b[1;32mGoal achieved!\x1b[0m\r\n`);
            agentCtx.stdout(`${toolUseContent.input.summary}\r\n`);
            return 0;
        }

        // Refresh screenshot after every action
        await executeAndCapture(agentCtx, screenshotCmd, []);
        agentCtx.stdout('\r\n');
    }

    agentCtx.stdout('Agent finished: reached max steps.\r\n');
    return 0;
  }
};
