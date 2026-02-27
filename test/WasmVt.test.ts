import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { GhosttyTerminal, Ghostty } from 'ghostty-web';

describe('GhosttyTerminal WASM integration', () => {
    let ghostty: Ghostty;
    let term: GhosttyTerminal;

    beforeAll(async () => {
        // Load the Ghostty WASM module once for all tests
        ghostty = await Ghostty.load();
    });

    beforeEach(() => {
        // Create a new terminal instance for each test
        term = ghostty.createTerminal(20, 10);
    });

    afterEach(() => {
        // Clean up the terminal instance after each test
        if (term) {
            term.free();
        }
    });

    it('should instantiate the terminal', () => {
        expect(term).toBeDefined();
        expect(term.cols).toBe(20);
        expect(term.rows).toBe(10);
    });

    it('should return a viewport', () => {
        const view = term.getViewport();
        expect(view).toBeDefined();
        // 20 cols * 10 rows
        expect(view.length).toBe(200);
    });

    it('should process input and update the screen', () => {
        term.write('h');
        term.update();

        const view = term.getViewport();
        // Each cell is a Uint32
        const firstCell = view[0];

        // The lower 21 bits are the codepoint
        const codepoint = firstCell.codepoint;
        
        // 'h' is codepoint 104
        expect(codepoint).toBe(104);
    });

    it('should mark rows as dirty and clean', () => {
        // Initially, no rows should be dirty
        for (let i = 0; i < 10; i++) {
            expect(term.isRowDirty(i)).toBe(false);
        }

        // Writing text should mark the first row as dirty after update
        term.write('hello');
        term.update();
        expect(term.isRowDirty(0)).toBe(true);
        for (let i = 1; i < 10; i++) {
            expect(term.isRowDirty(i)).toBe(false);
        }

        // Marking the row clean should reset its dirty state
        term.markClean();
        for (let i = 0; i < 10; i++) {
            expect(term.isRowDirty(i)).toBe(false);
        }
    });
});
