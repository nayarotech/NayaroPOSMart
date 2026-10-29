import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['node'] },
  test: { environment: 'node', testTimeout: 60_000, hookTimeout: 60_000, pool: 'forks' },
});
