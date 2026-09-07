import { promises as fs } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Precompress the heavy static payload (data/*.bin, *.json, models/*.glb) with Brotli so a static host that serves
 * precompressed files (nginx `brotli_static on`, Caddy `file_server { precompressed br }`, Cloudflare Pages, or
 * `npm run preview` here) sends 30-60 % fewer bytes. Writes `<file>.br` next to each file, skips files that already
 * have an up-to-date .br. Usage: tsx scripts/compress.ts [dir=dist]
 */
const root = path.resolve(process.argv[2] ?? 'dist');
const EXT = new Set(['.bin', '.json', '.glb', '.hdr']);
const MIN_BYTES = 64 * 1024;

async function* walk(dir: string): AsyncGenerator<string> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function main() {
  let inBytes = 0, outBytes = 0, n = 0, skipped = 0;
  const t0 = Date.now();
  for await (const file of walk(root)) {
    if (file.endsWith('.br') || !EXT.has(path.extname(file))) continue;
    const st = await fs.stat(file);
    if (st.size < MIN_BYTES) continue;
    const out = file + '.br';
    try { const so = await fs.stat(out); if (so.mtimeMs >= st.mtimeMs) { skipped++; inBytes += st.size; outBytes += so.size; continue; } } catch { /* absent */ }
    const buf = await fs.readFile(file);
    // text compresses well at high quality; float-heavy binaries barely improve past q5, and q5 is 10x faster
    const quality = path.extname(file) === '.json' ? 9 : 5;
    const br = zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: quality, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length } });
    await fs.writeFile(out, br);
    inBytes += buf.length; outBytes += br.length; n++;
    console.log(`${path.relative(root, file)}  ${(buf.length / 1048576).toFixed(1)} -> ${(br.length / 1048576).toFixed(1)} MB`);
  }
  console.log(`\n${n} compressed, ${skipped} up to date: ${(inBytes / 1048576).toFixed(0)} MB -> ${(outBytes / 1048576).toFixed(0)} MB (${(100 * (1 - outBytes / Math.max(1, inBytes))).toFixed(0)} % smaller) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch(e => { console.error(e); process.exit(1); });
