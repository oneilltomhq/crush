import { describe, it, expect, vi } from 'vitest';
import { StdinStream } from './program';

describe('StdinStream', () => {
  it('should queue pushed data before a consumer is ready', async () => {
    const stream = new StdinStream();
    stream.push('hello');
    stream.push('world');

    const iterator = stream[Symbol.asyncIterator]();
    const result1 = await iterator.next();
    const result2 = await iterator.next();

    expect(result1.value).toBe('hello');
    expect(result1.done).toBe(false);
    expect(result2.value).toBe('world');
    expect(result2.done).toBe(false);
  });

  it('should resolve a pending next() call when data is pushed', async () => {
    const stream = new StdinStream();
    const promise = stream[Symbol.asyncIterator]().next();
    stream.push('data');
    const result = await promise;

    expect(result.value).toBe('data');
    expect(result.done).toBe(false);
  });

  it('should unblock a pending next() call when closed', async () => {
    const stream = new StdinStream();
    const promise = stream[Symbol.asyncIterator]().next();
    stream.close();
    const result = await promise;

    expect(result.done).toBe(true);
  });

  it('should ignore data pushed after it is closed', async () => {
    const stream = new StdinStream();
    stream.close();
    stream.push('ignored data');

    const iterator = stream[Symbol.asyncIterator]();
    const result = await iterator.next();
    expect(result.done).toBe(true);
  });

  it('should work correctly with a for-await-of loop', async () => {
    const stream = new StdinStream();
    const received: string[] = [];

    const consume = async () => {
      for await (const chunk of stream) {
        received.push(chunk);
      }
    };

    const consumerPromise = consume();

    stream.push('a');
    stream.push('b');
    stream.push('c');
    stream.close();

    await consumerPromise;

    expect(received).toEqual(['a', 'b', 'c']);
  });
});
