import swc from 'unplugin-swc';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

// Integration tests against the local kind cluster (NF-16). Run with `pnpm test:int`.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  // Resolve like Node does at runtime: no bundler-only "module" condition/field (the AWS SDK's
  // dist-es builds use extensionless imports that only bundlers understand).
  ssr: {
    resolve: {
      conditions: [
        '@capi-navigator/source',
        ...defaultServerConditions.filter((c) => c !== 'module'),
      ],
      externalConditions: ['node'],
      mainFields: ['main'],
    },
  },
  test: {
    environment: 'node',
    include: ['test/integration/**/*.int.test.ts', 'test/live/**/*.live.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
