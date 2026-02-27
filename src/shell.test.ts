import { describe, it, expect, vi } from 'vitest';
import { LocalShell } from './shell';
import type { GhosttyTerminal } from 'ghostty-web';

// Mock the GhosttyTerminal dependency
const mockTerm = {
  write: vi.fn(),
} as unknown as GhosttyTerminal;

describe('LocalShell', () => {
  it('should be instantiable', () => {
    const shell = new LocalShell({ term: mockTerm });
    expect(shell).toBeInstanceOf(LocalShell);
  });
});
