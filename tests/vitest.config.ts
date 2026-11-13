import { defineConfig } from 'vitest/config';
import path from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      'typebox': require.resolve('typebox'),
      '@shared': path.resolve(__dirname, '../shared'),
      '@octogee/shared': path.resolve(__dirname, '../shared'),
    },
  },
  test: {
    include: [
      'specs/**/*.spec.ts',
      '../shared/types/**/*.spec.ts',
    ],
    setupFiles: ['./test-setup/user-entitlements.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    server: {
      deps: {
        inline: [/@octogee\/(core|shared)/],
      },
    },
  },
});
