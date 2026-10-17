import vue from '@vitejs/plugin-vue';
import { defaultClientConditions, defineConfig } from 'vite';
import vuetify from 'vite-plugin-vuetify';

const backendUrl = process.env.BACKEND_URL ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [vue(), vuetify({ autoImport: true })],
  resolve: { conditions: ['@capi-navigator/source', ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: { '/api': { target: backendUrl, changeOrigin: false, ws: true } },
  },
  // Pre-bundle the lazily loaded Monaco modules; otherwise Vite reloads the page on first use.
  optimizeDeps: {
    include: [
      'monaco-editor/editor/editor.api',
      'monaco-editor/languages/definitions/yaml/register',
      'monaco-editor/features/codicon/register',
      '@xterm/xterm',
      '@xterm/addon-fit',
    ],
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
