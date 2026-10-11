import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeomBuilder, encodeBinMesh } from './binmesh.ts';
import { BINMESH_VERSION, parseBinMesh } from '../../shared/binmesh.ts';

/** `n` quads with the builder's standard attributes (position f32x3, uv f32x2, meta f32x4, color u8x4). */
function quads(n: number): GeomBuilder {
  const gb = new GeomBuilder();
  for (let q = 0; q < n; q++) {
    const y = q * 3;
    const a = gb.vertex(0, y, 0, 0, 0, [3.1, 6, 10, 2 * 256 + 17], [200, 190, 180, 0]);
    const b = gb.vertex(10, y, 0, 10, 0, [3.1, 6, 10, 2 * 256 + 17], [200, 190, 180, 0]);
    const c = gb.vertex(10, y + 3, 0, 10, 3, [3.1, 6, 10, 2 * 256 + 17], [200, 190, 180, 0]);
    const d = gb.vertex(0, y + 3, 0, 0, 3, [3.1, 6, 10, 2 * 256 + 17], [200, 190, 180, 0]);
    gb.quad(a, b, c, d);
  }
  return gb;
}
const toArrayBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

test('PBM1 round-trips attributes, indices, origin and meta through the writer and the shared reader', () => {
  const gb = quads(3);
  const buf = encodeBinMesh({ x: -1536, z: 256 }, [{ ...gb.toSection('walls'), meta: { kind: 'test' } }], { buildings: 3 });
  const { header, arrays } = parseBinMesh(toArrayBuffer(buf), 'walls.bin');
  assert.equal(header.version, BINMESH_VERSION);
  assert.deepEqual(header.origin, { x: -1536, z: 256 });
  assert.deepEqual(header.meta, { buildings: 3 });
  assert.equal(header.sections.length, 1);
  const s = header.sections[0];
  assert.equal(s.name, 'walls'); assert.equal(s.vertexCount, 12); assert.equal(s.indexCount, 18); assert.equal(s.indexType, 'u16');
  assert.deepEqual(s.meta, { kind: 'test' });
  const w = arrays.get('walls')!;
  assert.deepEqual([...(w.attrs.get('position') as Float32Array)], gb.positions.map(v => Math.fround(v)));
  assert.deepEqual([...(w.attrs.get('uv') as Float32Array)], gb.uvs);
  assert.deepEqual([...(w.attrs.get('meta') as Float32Array)].map(v => Math.round(v * 1e5) / 1e5), gb.meta.map(v => Math.round(Math.fround(v) * 1e5) / 1e5));
  assert.deepEqual([...(w.attrs.get('color') as Uint8Array)], gb.colors);
  assert.deepEqual([...w.indices], gb.indices);
});

test('the u8 color array keeps the following section 4-byte aligned, and the file length matches the layout', () => {
  // 1 quad -> 4 vertices -> 16 colour bytes (already aligned); 3 quads -> 12 vertices -> 48; use 5 quads for 20 vertices
  // = 80 bytes, and a second section right after so its f32 arrays must start on a multiple of 4.
  const buf = encodeBinMesh({ x: 0, z: 0 }, [quads(5).toSection('a'), quads(1).toSection('b')]);
  const { header, arrays } = parseBinMesh(toArrayBuffer(buf));
  for (const s of header.sections) {
    for (const off of s.attrOffsets) assert.equal(off % 4, 0, `${s.name} attr at ${off}`);
    assert.equal(s.indexOffset % 4, 0);
  }
  assert.equal(arrays.get('b')!.indices.length, 6);
  const last = header.sections[1];
  assert.equal(buf.length, (last.indexOffset + last.indexCount * 2 + 3) & ~3, 'file ends right after the last (aligned) index array');
});

test('index type switches to u32 past 65535 vertices', () => {
  const gb = quads(16384);   // 65536 vertices: one past the u16 range
  const buf = encodeBinMesh({ x: 0, z: 0 }, [gb.toSection('big')]);
  const { header, arrays } = parseBinMesh(toArrayBuffer(buf));
  assert.equal(header.sections[0].indexType, 'u32');
  assert.ok(arrays.get('big')!.indices instanceof Uint32Array);
  assert.equal(arrays.get('big')!.indices[arrays.get('big')!.indices.length - 1], 65535, 'the last quad closes on vertex 65535');
});

test('a truncated file and a foreign version fail with a message naming the file', () => {
  const buf = encodeBinMesh({ x: 0, z: 0 }, [quads(2).toSection('walls')]);
  const cut = toArrayBuffer(buf).slice(0, buf.length - 10);
  assert.throws(() => parseBinMesh(cut, 'chunks/3_4.bin'), /chunks\/3_4\.bin: truncated/);
  assert.throws(() => parseBinMesh(toArrayBuffer(buf).slice(0, 6), 'x.bin'), /x\.bin: 6 bytes/);
  // patch the version inside the JSON header
  const text = buf.toString('latin1');
  const patched = Buffer.from(text.replace('"version":1', '"version":9'), 'latin1');
  assert.throws(() => parseBinMesh(toArrayBuffer(patched), 'old.bin'), /old\.bin: PBM1 version 9/);
  assert.throws(() => parseBinMesh(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer, 'junk'), /junk: not a PBM1 file/);
});
