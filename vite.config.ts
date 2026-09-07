import { defineConfig, type Plugin, type PreviewServer } from 'vite';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';

const MIME: Record<string, string> = { '.bin': 'application/octet-stream', '.json': 'application/json', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream' };

/**
 * `npm run preview` serves `<file>.br` (from `npm run compress`) with Content-Encoding: br when the browser accepts it,
 * the way a production host with precompressed-file support would. The dev server keeps serving the raw files.
 */
function precompressed(): Plugin {
  return {
    name: 'serve-precompressed-brotli',
    configurePreviewServer(server: PreviewServer) {
      const outDir = path.resolve(server.config.build.outDir);
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const ext = path.extname(url);
        if (!MIME[ext] || !/\bbr\b/.test(req.headers['accept-encoding'] as string ?? '')) return next();
        const file = path.join(outDir, decodeURIComponent(url)) + '.br';
        let size: number;
        try { size = statSync(file).size; } catch { return next(); }
        res.setHeader('Content-Type', MIME[ext]);
        res.setHeader('Content-Encoding', 'br');
        res.setHeader('Content-Length', String(size));
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  // Large model/data drops into public/ (a 200 MB glb being copied) raised EBUSY in the file watcher and killed the
  // dev server; those files are fetched at runtime, so there is nothing to hot-reload anyway.
  server: { port: 5173, open: false, watch: { ignored: ['**/public/models/**', '**/public/data/**', '**/cache/**'] } },
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: [] },
  plugins: [precompressed()],
});
