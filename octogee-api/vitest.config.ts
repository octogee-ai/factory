import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig `paths` mapping so vitest + tsx resolve
      // `@shared/types/identity` and other shared modules at runtime.
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  test: {
    setupFiles: ['./src/test-setup/firebase-offline.ts'],
    // Run files serially: under concurrent file execution the forks pool
    // intermittently drops a spec's own lib/db vi.mock, so specs that pass in
    // isolation flake in-suite. Serial is the reliable fix (tests within a file
    // still run together).
    fileParallelism: false,
    // Serial integration specs drive real HTTP via supertest; 5s is tight under
    // load, and the real hangs (firebase ADC) are already gone.
    testTimeout: 15000,
    exclude: [
      'dist/**',
      'node_modules/**',
      // Don't run gateway-edge's own specs from here — gateway-edge
      // is the owner of those. We pull in gateway-edge/src/ for route
      // handler reuse only.
      '../gateway-edge/**',
    ],
  },
});
