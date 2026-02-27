import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    typecheck: {
      include: ['test/**/*.test.ts'],
    },
    // The test environment defaults to 'node', which is what we want.
    // Explicitly setting it just in case.
    environment: 'node',
  },
});
