import swc from 'unplugin-swc';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Integration tests against the local kind cluster (NF-16). Run with `pnpm test:int`.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  ssr: { resolve: { conditions: ['@capi-navigator/source', ...defaultServerConditions] } },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.int.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
