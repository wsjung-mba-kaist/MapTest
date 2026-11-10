/**
 * Fill cache/ from the published bake cache (CACHE_ARCHIVE in config.ts), so a fresh clone can run the offline bake
 * steps (build, paths, markings, streets, masks, far) without Overpass or IGN. The archive is checked against its
 * SHA-256 before anything is extracted and deleted after a clean extraction.
 *
 *   npm run cache:fetch              # stops when cache/ already holds downloaded data (it may be newer than the archive)
 *   npm run cache:fetch -- --force   # extract over it: files in the archive are replaced, everything else is kept
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CACHE_ARCHIVE, CACHE_DIR, ROOT } from './config.ts';
import { log } from './lib/log.ts';

/** The archive's top-level folders: any of them non-empty means this PC already has a cache of its own. */
const DATA_DIRS = ['overpass', 'osm', 'bdtopo', 'bil', 'wmts', 'ortho_raw', 'dsm', 'paris', 'assets', 'models'];
const MB = 1 << 20;

async function nonEmpty(dir: string): Promise<boolean> {
  try { return (await fs.readdir(dir)).length > 0; } catch { return false; }
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function download(url: string, out: string, bytes: number): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  const part = `${out}.part`;
  let got = 0, next = 0.1;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c: Buffer) => {
    got += c.length;
    if (got >= next * bytes) { log.info(`cache: ${Math.round(got / MB)} / ${Math.round(bytes / MB)} MB`); next += 0.1; }
  });
  await pipeline(body, createWriteStream(part));
  await fs.rename(part, out);
}

async function main() {
  const force = process.argv.includes('--force');
  if (!force) for (const d of DATA_DIRS) {
    if (await nonEmpty(path.join(CACHE_DIR, d))) throw new Error(`cache/${d} already holds data, and this PC's cache may be newer than the archive; rerun with -- --force to extract over it`);
  }
  const dir = path.join(CACHE_DIR, '.download');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, path.posix.basename(new URL(CACHE_ARCHIVE.url).pathname));
  const have = await fs.stat(file).then(s => s.size === CACHE_ARCHIVE.bytes, () => false);
  if (have) log.info('cache: archive already downloaded');
  else { log.info(`cache: downloading ${CACHE_ARCHIVE.url}`); await download(CACHE_ARCHIVE.url, file, CACHE_ARCHIVE.bytes); }

  const digest = await sha256(file);
  if (digest !== CACHE_ARCHIVE.sha256) {
    await fs.rm(file);
    throw new Error(`cache: SHA-256 mismatch (got ${digest}); the corrupt download was deleted, rerun`);
  }
  // a relative path from the repo root: GNU tar (Git Bash) reads "C:\…" as host:path; it and Windows' bsdtar both take this
  const rel = path.relative(ROOT, file).split(path.sep).join('/');
  log.info('cache: SHA-256 ok, extracting');
  const r = spawnSync('tar', ['-xzf', rel], { cwd: ROOT, stdio: 'inherit' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`tar exited with ${r.status}`);
  await fs.rm(file);
  log.info(`cache: done, ${path.relative(process.cwd(), CACHE_DIR) || 'cache'}/ is ready for the offline bake steps`);
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
