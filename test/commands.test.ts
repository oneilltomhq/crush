import { describe, it, expect, beforeEach } from 'vitest';
import { lsCmd, catCmd, mkdirCmd, rmCmd } from '../src/commands';
import { MemoryWorkspaceFS } from '../src/fs';
import type { ProgramContext } from '../src/program';
import type { CrushProgram } from '../src/program';

// A mock terminal for testing command output
class MockTerm {
    output = '';
    write(data: string) {
        this.output += data;
    }
    clear() {
        this.output = '';
    }
}

describe('Filesystem Commands', () => {
    let fs: MemoryWorkspaceFS;
    let term: MockTerm;
    let context: ProgramContext;

    beforeEach(() => {
        fs = new MemoryWorkspaceFS();
        term = new MockTerm();
        context = {
            fs,
            stdout: (data) => term.write(data),
            stderr: (data) => term.write(`ERR: ${data}`),
            args: [],
            // These can be dummy values for most fs commands
            term: {} as any,
            stdin: (async function*() {})(),
            abortSignal: new AbortController().signal,
            chrome: async () => {},
        };
    });

    // Helper to run a command
    async function runCommand(cmd: CrushProgram, args: string[]) {
        term.clear();
        context.args = args;
        const exitCode = await cmd.run(context);
        return { exitCode, output: term.output };
    }

    describe('mkdir', () => {
        it('should create a directory', async () => {
            const { exitCode } = await runCommand(mkdirCmd, ['test-dir']);
            expect(exitCode).toBe(0);
            const entries = await fs.list('.');
            expect(entries).toEqual([{ name: 'test-dir', kind: 'directory' }]);
        });

        it('should create nested directories with mkdirp logic', async () => {
            const { exitCode } = await runCommand(mkdirCmd, ['a/b/c']);
            expect(exitCode).toBe(0);
            const entries = await fs.list('a/b');
            expect(entries).toEqual([{ name: 'c', kind: 'directory' }]);
        });

        it('should return an error if no path is provided', async () => {
            const { exitCode, output } = await runCommand(mkdirCmd, []);
            expect(exitCode).toBe(1);
            expect(output).toContain('Usage: mkdir <path>');
        });
    });

    describe('ls', () => {
        beforeEach(async () => {
            await fs.mkdirp('dir1');
            await fs.writeText('file1.txt', 'hello');
        });

        it('should list contents of the root directory', async () => {
            const { output } = await runCommand(lsCmd, ['.']);
            // ANSI codes: \x1b[1;34m (bold blue) and \x1b[0m (reset)
            expect(output).toContain('\x1b[1;34mdir1/\x1b[0m');
            expect(output).toContain('file1.txt');
        });

        it('should list contents of a subdirectory', async () => {
            await fs.writeText('dir1/file2.txt', 'world');
            const { output } = await runCommand(lsCmd, ['dir1']);
            expect(output).toBe('file2.txt\r\n');
        });

        it('should handle an empty directory', async () => {
            await fs.mkdirp('empty-dir');
            const { output } = await runCommand(lsCmd, ['empty-dir']);
            // ls should produce no output for an empty directory, just a prompt would follow
            expect(output).toBe('');
        });

        it('should return an error for a non-existent directory', async () => {
            const { exitCode, output } = await runCommand(lsCmd, ['nonexistent']);
            expect(exitCode).toBe(1);
            expect(output).toContain('ls:');
        });
    });

    describe('cat', () => {
        beforeEach(async () => {
            await fs.writeText('test.txt', 'hello world');
        });

        it('should print the content of a file', async () => {
            const { output } = await runCommand(catCmd, ['test.txt']);
            expect(output).toBe('hello world\r\n');
        });

        it('should return an error if no path is provided', async () => {
            const { exitCode, output } = await runCommand(catCmd, []);
            expect(exitCode).toBe(1);
            expect(output).toContain('Usage: cat <path>');
        });

        it('should return an error for a non-existent file', async () => {
            const { exitCode, output } = await runCommand(catCmd, ['nonexistent.txt']);
            expect(exitCode).toBe(1);
            expect(output).toContain('cat:');
        });
    });

    describe('rm', () => {
        beforeEach(async () => {
            await fs.mkdirp('dir1');
            await fs.writeText('file1.txt', 'hello');
        });

        it('should remove a file', async () => {
            const { exitCode } = await runCommand(rmCmd, ['file1.txt']);
            expect(exitCode).toBe(0);
            const exists = await fs.exists('file1.txt');
            expect(exists).toBe(false);
        });

        it('should remove a directory', async () => {
            const { exitCode } = await runCommand(rmCmd, ['dir1']);
            expect(exitCode).toBe(0);
            const exists = await fs.exists('dir1');
            expect(exists).toBe(false);
        });
        
        it('should return an error if no path is provided', async () => {
            const { exitCode, output } = await runCommand(rmCmd, []);
            expect(exitCode).toBe(1);
            expect(output).toContain('Usage: rm <path>');
        });
    });
});
