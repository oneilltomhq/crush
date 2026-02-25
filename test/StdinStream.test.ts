import { describe, it, expect } from 'vitest';
import { StdinStream } from '../src/program.js';

describe('StdinStream', () => {
  describe('queue behavior', () => {
    it('yields data pushed before next() is called', async () => {
      const stream = new StdinStream();
      stream.push('hello');
      stream.close();

      const results: string[] = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      expect(results).toEqual(['hello']);
    });

    it('yields data in FIFO order', async () => {
      const stream = new StdinStream();
      stream.push('first');
      stream.push('second');
      stream.push('third');
      stream.close();

      const results: string[] = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      expect(results).toEqual(['first', 'second', 'third']);
    });

    it('handles interleaved push and consume', async () => {
      const stream = new StdinStream();
      stream.push('a');

      const iterator = stream[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first).toEqual({ value: 'a', done: false });

      stream.push('b');
      const second = await iterator.next();
      expect(second).toEqual({ value: 'b', done: false });

      stream.close();
      const third = await iterator.next();
      expect(third).toEqual({ value: undefined, done: true });
    });
  });

  describe('close behavior', () => {
    it('unblocks pending next() when closed', async () => {
      const stream = new StdinStream();
      const iterator = stream[Symbol.asyncIterator]();

      // Start waiting for data (nothing in queue)
      const promise = iterator.next();

      // Close while waiting
      stream.close();

      // Should resolve with done: true
      const result = await promise;
      expect(result).toEqual({ value: undefined, done: true });
    });

    it('ends iteration when closed after data', async () => {
      const stream = new StdinStream();
      stream.push('data');
      stream.close();

      const results: string[] = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      expect(results).toEqual(['data']);
    });

    it('multiple close() calls are safe', async () => {
      const stream = new StdinStream();
      stream.close();
      stream.close();
      stream.close();

      const iterator = stream[Symbol.asyncIterator]();
      const result = await iterator.next();
      expect(result.done).toBe(true);
    });
  });

  describe('push after close', () => {
    it('ignores push() after close()', async () => {
      const stream = new StdinStream();
      stream.push('before');
      stream.close();
      stream.push('after'); // Should be ignored

      const results: string[] = [];
      for await (const chunk of stream) {
        results.push(chunk);
      }

      expect(results).toEqual(['before']);
    });

    it('ignores push() when stream was closed empty', async () => {
      const stream = new StdinStream();
      stream.close();
      stream.push('ignored');

      const iterator = stream[Symbol.asyncIterator]();
      const result = await iterator.next();
      expect(result.done).toBe(true);
    });
  });
});
