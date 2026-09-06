/**
 * Tiny binary mesh container shared by the bake writer (Node) and the runtime reader (browser).
 *
 * File = magic "PBM1" | u32 headerLength | header JSON (utf8, padded to 4 bytes) | section data.
 * Each section stores its attribute arrays back-to-back (each 4-byte aligned) then its index array.
 */

export type AttrType = 'f32' | 'u8' | 'u16' | 'u32' | 'i16';

export interface AttrSpec { name: string; size: number; type: AttrType; normalized?: boolean }

export interface SectionHeader {
  name: string;
  vertexCount: number;
  indexCount: number;
  indexType: 'u16' | 'u32';
  attrs: AttrSpec[];
  /** Byte offsets of each attribute array (same order as attrs) relative to file start. */
  attrOffsets: number[];
  indexOffset: number;
  /** Optional free-form metadata (e.g. bounds). */
  meta?: Record<string, unknown>;
}

export interface BinMeshHeader {
  version: 1;
  origin: { x: number; z: number };
  sections: SectionHeader[];
  meta?: Record<string, unknown>;
}

export const BINMESH_MAGIC = 0x314d4250; // "PBM1" little-endian

export const BYTES: Record<AttrType, number> = { f32: 4, u8: 1, u16: 2, u32: 4, i16: 2 };

export function align4(n: number): number { return (n + 3) & ~3; }

/** Parse a PBM1 buffer into header + typed-array views (no copies). */
export function parseBinMesh(buf: ArrayBuffer): { header: BinMeshHeader; arrays: Map<string, { attrs: Map<string, ArrayBufferView>; indices: Uint16Array | Uint32Array }> } {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== BINMESH_MAGIC) throw new Error('not a PBM1 file');
  const hlen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen))) as BinMeshHeader;
  const arrays = new Map<string, { attrs: Map<string, ArrayBufferView>; indices: Uint16Array | Uint32Array }>();
  for (const s of header.sections) {
    const attrs = new Map<string, ArrayBufferView>();
    s.attrs.forEach((a, k) => {
      const count = s.vertexCount * a.size;
      const off = s.attrOffsets[k];
      const view =
        a.type === 'f32' ? new Float32Array(buf, off, count) :
        a.type === 'u8' ? new Uint8Array(buf, off, count) :
        a.type === 'u16' ? new Uint16Array(buf, off, count) :
        a.type === 'i16' ? new Int16Array(buf, off, count) :
        new Uint32Array(buf, off, count);
      attrs.set(a.name, view);
    });
    const indices = s.indexType === 'u16' ? new Uint16Array(buf, s.indexOffset, s.indexCount) : new Uint32Array(buf, s.indexOffset, s.indexCount);
    arrays.set(s.name, { attrs, indices });
  }
  return { header, arrays };
}
