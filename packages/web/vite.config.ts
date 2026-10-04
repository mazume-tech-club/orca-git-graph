import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In dev the API is served by `packages/server`; scripts/dev.mjs passes its port.
const apiPort = process.env.ORCA_GIT_GRAPH_PORT ?? '0';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: {
    host: '127.0.0.1',
    proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: true } },
  },
});
