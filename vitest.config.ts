import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Keep all three projects' source tests; archived release snapshots are evidence only.
    include: ['src/**/*.test.{ts,tsx}', 'checkout/src/**/*.test.{ts,tsx}', 'dashboard/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', 'test-reports/**'],
    // Pre-fill env vars before src/config/env.ts loads, so tests can import
    // modules that transitively touch config without process.exit(1).
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
