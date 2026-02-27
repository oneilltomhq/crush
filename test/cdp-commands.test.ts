// test/cdp-commands.test.ts

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock modules BEFORE they are imported
vi.mock('../src/renderer', () => ({
  updateScreenshotTexture: vi.fn(),
}));
vi.mock('../src/sidepanel', () => import('./mocks/sidepanel'));


import {
  attachCmd,
  detachCmd,
  navigateCmd,
  clickCmd,
  typeCmd,
  screenshotCmd,
  evaluateCmd,
} from '../src/commands';
import type { ProgramContext } from '../src/program';
import { StdinStream } from '../src/program';
import { updateScreenshotTexture } from '../src/renderer';
import { cdpEventBus } from '../src/sidepanel';


describe('CDP Commands', () => {
  let ctx: ProgramContext;
  let stdout: string;
  let stderr: string;
  const mockChromeRpc = vi.fn();

  beforeEach(() => {
    stdout = '';
    stderr = '';
    mockChromeRpc.mockReset();
    vi.clearAllMocks();
    (cdpEventBus.once as vi.Mock).mockReset();

    ctx = {
      stdout: (data: string) => { stdout += data; },
      stderr: (data: string) => { stderr += data; },
      stdin: new StdinStream(),
      args: [],
      term: {} as any, // Not used by these commands
      abortSignal: new AbortController().signal,
      chrome: mockChromeRpc,
      fs: {} as any, // Not used by these commands
      cwd: '/',
    };
  });

  describe('attach', () => {
    it('should attach to the active tab', async () => {
      mockChromeRpc.mockImplementation(async (action) => {
        if (action === 'tabs.query') {
          return [{ id: 123 }];
        }
        if (action === 'debugger.attach') {
          return;
        }
      });

      const exitCode = await attachCmd.run(ctx);

      expect(exitCode).toBe(0);
      expect(mockChromeRpc).toHaveBeenCalledWith('tabs.query', { active: true, currentWindow: true });
      expect(mockChromeRpc).toHaveBeenCalledWith('debugger.attach', { tabId: 123 }, '1.3');
      expect(stdout).toContain('Attached to active tab.');
    });

    it('should return an error if no active tab is found', async () => {
      mockChromeRpc.mockResolvedValue([]); // No tabs found
      
      const exitCode = await attachCmd.run(ctx);

      expect(exitCode).toBe(1);
      expect(stderr).toContain('Error: No active tab found');
    });
  });

  describe('detach', () => {
    it('should detach from the tab', async () => {
      mockChromeRpc.mockResolvedValue(undefined);
      
      const exitCode = await detachCmd.run(ctx);

      expect(exitCode).toBe(0);
      expect(mockChromeRpc).toHaveBeenCalledWith('debugger.detach');
      expect(stdout).toContain('Detached from tab.');
    });
  });

  describe('navigate', () => {
    it('should attempt to navigate', async () => {
      const url = 'https://example.com';
      ctx.args = [url];
      
      mockChromeRpc.mockResolvedValue({});
      // We are not testing the timeout here, just that the command is sent.
      (cdpEventBus.once as vi.Mock).mockImplementation((eventName, listener) => {
        if (eventName === 'Page.loadEventFired') {
          listener({});
        }
      });
      
      await navigateCmd.run(ctx);

      expect(mockChromeRpc).toHaveBeenCalledWith('debugger.sendCommand', 'Page.navigate', { url });
      expect(stdout).toContain('Page loaded.');
    });

  });

  describe('click', () => {
    it('should click on an element by selector', async () => {
        ctx.args = ['#my-button'];
        mockChromeRpc.mockImplementation(async (action, method) => {
            if (method === 'Runtime.evaluate') {
                return { result: { result: { value: JSON.stringify({ x: 100, y: 50 }) } } };
            }
        });

        const exitCode = await clickCmd.run(ctx);
        
        expect(exitCode).toBe(0);
        expect(mockChromeRpc).toHaveBeenCalledWith('debugger.sendCommand', 'Input.dispatchMouseEvent', {
            type: 'mousePressed', x: 100, y: 50, button: 'left', clickCount: 1,
        });
        expect(mockChromeRpc).toHaveBeenCalledWith('debugger.sendCommand', 'Input.dispatchMouseEvent', {
            type: 'mouseReleased', x: 100, y: 50, button: 'left', clickCount: 1,
        });
        expect(stdout).toContain('Clicked on #my-button');
    });

    it('should return an error if element is not found', async () => {
        ctx.args = ['#non-existent'];
        mockChromeRpc.mockResolvedValue({
            result: {
                exceptionDetails: { exception: { description: 'Error: Element not found' } }
            }
        });
        
        const exitCode = await clickCmd.run(ctx);
        
        expect(exitCode).toBe(1);
        expect(stderr).toContain('Error: Element not found');
    });
  });
  
  describe('type', () => {
      it('should type the given text', async () => {
          ctx.args = ['hello', 'world'];
          await typeCmd.run(ctx);
          expect(mockChromeRpc).toHaveBeenCalledWith('debugger.sendCommand', 'Input.insertText', { text: 'hello world' });
      });

      it('should handle special keys', async () => {
          ctx.args = ['{enter}', 'text', '{tab}'];
          await typeCmd.run(ctx);
          
          const calls = mockChromeRpc.mock.calls;
          expect(calls.some(call => call[1] === 'Input.dispatchKeyEvent' && call[2].key === 'Enter')).toBe(true);
          expect(calls.some(call => call[1] === 'Input.insertText' && call[2].text === 'text')).toBe(true);
          expect(calls.some(call => call[1] === 'Input.dispatchKeyEvent' && call[2].key === 'Tab')).toBe(true);
      });
  });

  describe('screenshot', () => {
      it('should capture a screenshot', async () => {
          mockChromeRpc.mockResolvedValue({ data: 'base64-data' });
          await screenshotCmd.run(ctx);
          expect(mockChromeRpc).toHaveBeenCalledWith('debugger.sendCommand', 'Page.captureScreenshot', {});
          expect(updateScreenshotTexture).toHaveBeenCalledWith('base64-data');
      });
  });
  
  describe('evaluate', () => {
      it('should evaluate a JS expression', async () => {
          ctx.args = ['1', '+', '1'];
          mockChromeRpc.mockResolvedValue({ result: { value: 2 } });
          await evaluateCmd.run(ctx);
          expect(stdout).toContain('2');
      });

      it('should handle evaluation errors', async () => {
          ctx.args = ['throw new Error("test")'];
          mockChromeRpc.mockResolvedValue({
              exceptionDetails: { exception: { description: 'Error: test' } }
          });
          const exitCode = await evaluateCmd.run(ctx);
          expect(exitCode).toBe(1);
          expect(stderr).toContain('Error: test');
      });
  });
});
