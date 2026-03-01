import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryWorkspaceFS } from '../src/fs.js';

describe('MemoryWorkspaceFS', () => {
  let fs: MemoryWorkspaceFS;

  beforeEach(() => {
    fs = new MemoryWorkspaceFS();
  });

  describe('path normalisation', () => {
    it('rejects .. traversal attempts', async () => {
      await expect(fs.readText('../secret')).rejects.toThrow('Path traversal');
      await expect(fs.readText('foo/../../bar')).rejects.toThrow('Path traversal');
      await expect(fs.writeText('..', 'data')).rejects.toThrow('Path traversal');
    });

    it('accepts paths without traversal', async () => {
      await fs.writeText('foo/bar.txt', 'data');
      expect(await fs.readText('foo/bar.txt')).toBe('data');
    });

    it('normalises leading/trailing slashes', async () => {
      await fs.writeText('/test.txt', 'a');
      await fs.writeText('test2.txt/', 'b');
      expect(await fs.readText('test.txt')).toBe('a');
      expect(await fs.readText('test2.txt')).toBe('b');
    });

    it('normalises multiple slashes', async () => {
      await fs.writeText('foo///bar//baz.txt', 'data');
      expect(await fs.readText('foo/bar/baz.txt')).toBe('data');
    });
  });

  describe('basic CRUD', () => {
    it('writes and reads a file', async () => {
      await fs.writeText('hello.txt', 'Hello, world!');
      expect(await fs.readText('hello.txt')).toBe('Hello, world!');
    });

    it('overwrites existing file', async () => {
      await fs.writeText('test.txt', 'original');
      await fs.writeText('test.txt', 'updated');
      expect(await fs.readText('test.txt')).toBe('updated');
    });

    it('throws when reading non-existent file', async () => {
      await expect(fs.readText('missing.txt')).rejects.toThrow('File not found');
    });

    it('removes a file', async () => {
      await fs.writeText('to-delete.txt', 'data');
      await fs.remove('to-delete.txt');
      await expect(fs.readText('to-delete.txt')).rejects.toThrow();
    });

    it('throws when removing non-existent path', async () => {
      await expect(fs.remove('missing.txt')).rejects.toThrow('Not found');
    });
  });

  describe('directories', () => {
    it('creates directories with mkdirp', async () => {
      await fs.mkdirp('a/b/c');
      expect(await fs.exists('a')).toBe(true);
      expect(await fs.exists('a/b')).toBe(true);
      expect(await fs.exists('a/b/c')).toBe(true);
    });

    it('mkdirp is idempotent', async () => {
      await fs.mkdirp('foo');
      await fs.mkdirp('foo'); // Should not throw
      expect(await fs.exists('foo')).toBe(true);
    });

    it('lists directory contents', async () => {
      await fs.writeText('a.txt', 'a');
      await fs.writeText('b.txt', 'b');
      await fs.mkdirp('subdir');

      const entries = await fs.list('.');
      expect(entries).toEqual([
        { name: 'a.txt', kind: 'file' },
        { name: 'b.txt', kind: 'file' },
        { name: 'subdir', kind: 'directory' },
      ]);
    });

    it('lists nested directory', async () => {
      await fs.writeText('src/main.ts', 'code');
      await fs.writeText('src/utils.ts', 'utils');

      const entries = await fs.list('src');
      expect(entries).toEqual([
        { name: 'main.ts', kind: 'file' },
        { name: 'utils.ts', kind: 'file' },
      ]);
    });

    it('throws when listing non-existent directory', async () => {
      await expect(fs.list('missing')).rejects.toThrow();
    });

    it('removes directory recursively', async () => {
      await fs.writeText('dir/a.txt', 'a');
      await fs.writeText('dir/sub/b.txt', 'b');
      await fs.remove('dir');

      expect(await fs.exists('dir')).toBe(false);
      expect(await fs.exists('dir/a.txt')).toBe(false);
    });
  });

  describe('exists', () => {
    it('returns true for existing file', async () => {
      await fs.writeText('test.txt', 'data');
      expect(await fs.exists('test.txt')).toBe(true);
    });

    it('returns true for existing directory', async () => {
      await fs.mkdirp('mydir');
      expect(await fs.exists('mydir')).toBe(true);
    });

    it('returns false for non-existent path', async () => {
      expect(await fs.exists('missing')).toBe(false);
    });

    it('root always exists', async () => {
      expect(await fs.exists('')).toBe(true);
      expect(await fs.exists('.')).toBe(true);
    });
  });

  describe('nested paths', () => {
    it('creates parent directories automatically on write', async () => {
      await fs.writeText('deeply/nested/path/file.txt', 'content');
      expect(await fs.readText('deeply/nested/path/file.txt')).toBe('content');
    });

    it('handles deeply nested structures', async () => {
      await fs.writeText('a/b/c/d/e/f.txt', 'deep');
      expect(await fs.exists('a/b/c/d/e')).toBe(true);
      expect(await fs.readText('a/b/c/d/e/f.txt')).toBe('deep');
    });
  });
});
