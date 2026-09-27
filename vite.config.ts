import { defineConfig } from 'vite';

// The API/WebSocket server; override to point a second dev setup at another server.
const API = process.env.SONGSURF_API || process.env.RIDEX_API || 'http://localhost:8787';

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      '/ws': { target: API.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
  },
  worker: {
    format: 'es',
  },
});
