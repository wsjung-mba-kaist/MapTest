import { defineConfig } from 'vite';

export default defineConfig({
  // Large model/data drops into public/ (a 200 MB glb being copied) raised EBUSY in the file watcher and killed the
  // dev server; those files are fetched at runtime, so there is nothing to hot-reload anyway.
  server: { port: 5173, open: false, watch: { ignored: ['**/public/models/**', '**/public/data/**', '**/cache/**'] } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: [] },
});
