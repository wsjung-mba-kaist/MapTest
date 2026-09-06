import { align4, BINMESH_MAGIC, BYTES, type AttrSpec, type BinMeshHeader, type SectionHeader } from '../../shared/binmesh.ts';

/** Growable typed-array builder used by geometry generators. */
export class GeomBuilder {
  positions: number[] = [];
  uvs: number[] = [];
  meta: number[] = [];     // 4 floats per vertex: floorHeight, levels, wallLength, seed
  colors: number[] = [];   // 4 bytes per vertex: r, g, b, flag
  indices: number[] = [];

  get vertexCount() { return this.positions.length / 3; }

  vertex(x: number, y: number, z: number, u: number, v: number, m: [number, number, number, number], c: [number, number, number, number]): number {
    this.positions.push(x, y, z);
    this.uvs.push(u, v);
    this.meta.push(m[0], m[1], m[2], m[3]);
    this.colors.push(c[0], c[1], c[2], c[3]);
    return this.vertexCount - 1;
  }
  tri(a: number, b: number, c: number) { this.indices.push(a, b, c); }
  quad(a: number, b: number, c: number, d: number) { this.indices.push(a, b, c, a, c, d); }

  toSection(name: string): SectionInput {
    return {
      name,
      attrs: [
        { spec: { name: 'position', size: 3, type: 'f32' }, data: new Float32Array(this.positions) },
        { spec: { name: 'uv', size: 2, type: 'f32' }, data: new Float32Array(this.uvs) },
        { spec: { name: 'meta', size: 4, type: 'f32' }, data: new Float32Array(this.meta) },
        { spec: { name: 'color', size: 4, type: 'u8', normalized: true }, data: new Uint8Array(this.colors) },
      ],
      indices: this.indices,
      vertexCount: this.vertexCount,
    };
  }
}

export interface SectionInput {
  name: string;
  attrs: { spec: AttrSpec; data: ArrayBufferView }[];
  indices: number[] | Uint16Array | Uint32Array;
  vertexCount: number;
  meta?: Record<string, unknown>;
}

export function encodeBinMesh(origin: { x: number; z: number }, sections: SectionInput[], meta?: Record<string, unknown>): Buffer {
  // First pass: compute layout with a placeholder header length, then finalize.
  const build = (headerLen: number) => {
    let cursor = align4(8 + headerLen);
    const headers: SectionHeader[] = [];
    const blobs: { off: number; data: Uint8Array }[] = [];
    for (const s of sections) {
      const attrOffsets: number[] = [];
      for (const a of s.attrs) {
        attrOffsets.push(cursor);
        const bytes = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
        blobs.push({ off: cursor, data: bytes });
        cursor = align4(cursor + bytes.byteLength);
      }
      const u16 = s.vertexCount <= 65535;
      const idx = u16 ? new Uint16Array(s.indices) : new Uint32Array(s.indices);
      const indexOffset = cursor;
      blobs.push({ off: cursor, data: new Uint8Array(idx.buffer, idx.byteOffset, idx.byteLength) });
      cursor = align4(cursor + idx.byteLength);
      headers.push({
        name: s.name, vertexCount: s.vertexCount, indexCount: idx.length, indexType: u16 ? 'u16' : 'u32',
        attrs: s.attrs.map(a => a.spec), attrOffsets, indexOffset, meta: s.meta,
      });
    }
    const header: BinMeshHeader = { version: 1, origin, sections: headers, meta };
    return { header, blobs, total: cursor };
  };
  // Header JSON length depends on offsets; iterate until stable (2-3 passes).
  let headerLen = 0;
  let result = build(headerLen);
  let json = Buffer.from(JSON.stringify(result.header), 'utf8');
  for (let i = 0; i < 6 && json.length !== headerLen; i++) {
    headerLen = json.length;
    result = build(headerLen);
    json = Buffer.from(JSON.stringify(result.header), 'utf8');
  }
  if (json.length !== headerLen) throw new Error('binmesh header did not converge');
  const out = Buffer.alloc(result.total);
  out.writeUInt32LE(BINMESH_MAGIC, 0);
  out.writeUInt32LE(headerLen, 4);
  json.copy(out, 8);
  for (const b of result.blobs) out.set(b.data, b.off);
  return out;
}

export const attrBytes = (a: AttrSpec) => BYTES[a.type] * a.size;
