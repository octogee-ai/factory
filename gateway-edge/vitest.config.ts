import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: ['dist/**', 'node_modules/**'],
    setupFiles: ['./src/test-setup/loopback-listen.ts'],
    // Subprocess-heavy specs (real git, tsx boot) fit 5s only on an idle
    // machine; parallel suites on a loaded Mac starve them into timeouts.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
