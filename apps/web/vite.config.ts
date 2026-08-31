import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The Mini App is a plain SPA. In prod the API server serves `dist/`; in dev
 * Vite serves it and proxies `/api` (REST + the SSE stream) to the API server.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // `@groupie/shared` is a workspace symlink outside this app's root.
    fs: { allow: ['..', '../..'] },
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
