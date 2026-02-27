// test/mocks/sidepanel.ts
import { vi } from 'vitest';
import type { EventEmitter } from '../../src/events';

export const cdpEventBus = {
  emit: vi.fn(),
  once: vi.fn(),
  off: vi.fn(),
} as unknown as EventEmitter;
