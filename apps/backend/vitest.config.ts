import swc from 'unplugin-swc';
import { defaultServerConditions } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC instead of esbuild: NestJS dependency injection needs emitDecoratorMetadata.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  ssr: { resolve: { conditions: ['@capi-navigator/source', ...defaultServerConditions] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
