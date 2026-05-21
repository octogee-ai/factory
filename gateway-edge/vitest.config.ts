import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors the tsconfig `paths` mapping — lets vitest + tsx resolve
      // `@shared/types/identity` and other shared modules at runtime.
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  test: {
    exclude: ['dist/**', 'node_modules/**'],
  },
});
