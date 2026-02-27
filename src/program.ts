/**
 * CrushProgram — the interface for programs that run inside the crush shell.
 */

import type { GhosttyTerminal } from 'ghostty-web';
import type { rpc } from './chrome-rpc';
import type { WorkspaceFS } from './fs';
import type { Scene } from 'three';

/** Context provided to a running program */
export interface ProgramContext {
  stdout: (data: string) => void;
  stderr: (data: string) => void;
  stdin: AsyncIterable<string>;
  args: string[];
  term: GhosttyTerminal;
  scene: Scene;
  abortSignal: AbortSignal;
  chrome: typeof rpc;
  fs: WorkspaceFS;
  cwd: string;
}

/** A program that can run inside the crush shell */
export interface CrushProgram {
  run(ctx: ProgramContext): Promise<number>;
}

/**
 * Writable + closable stdin stream.
 */
export class StdinStream implements AsyncIterable<string> {
  private queue: string[] = [];
  private resolve: ((value: IteratorResult<string>) => void) | null = null;
  private closed = false;

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
