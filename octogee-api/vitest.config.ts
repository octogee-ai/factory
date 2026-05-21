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
    exclude: [
      'dist/**',
      'node_modules/**',
      // Don't run workspace-api's own specs from here — workspace-api
      // is the owner of those. We pull in workspace-api/src/ for route
      // handler reuse only.
      '../workspace-api/**',
    ],
  },
});
