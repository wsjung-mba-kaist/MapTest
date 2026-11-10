/**
 * Tiny binary mesh container shared by the bake writer (Node) and the runtime reader (browser).
 *
 * File = magic "PBM1" | u32 headerLength | header JSON (utf8, padded to 4 bytes) | section data.
 * Each section stores its attribute arrays back-to-back (each 4-byte aligned) then its index array.
 * Every multi-byte value is little-endian: the magic and header length explicitly, the attribute and index arrays
 * because they are written as host typed arrays on a little-endian machine and read back as typed-array views.
 * `header.version` is BINMESH_VERSION; bump it when the layout changes and the reader will refuse stale files
 * instead of failing deep inside a loader with a missing attribute.
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

export const BINMESH_VERSION = 1;

export interface BinMeshHeader {
  version: typeof BINMESH_VERSION;
  origin: { x: number; z: number };
  sections: SectionHeader[];
  meta?: Record<string, unknown>;
}

export const BINMESH_MAGIC = 0x314d4250; // "PBM1" little-endian

export const BYTES: Record<AttrType, number> = { f32: 4, u8: 1, u16: 2, u32: 4, i16: 2 };

export function align4(n: number): number { return (n + 3) & ~3; }

/** Host byte order; the file format (and every raw Float32/Int16 side file) assumes little-endian. */
export const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** Parse a PBM1 buffer into header + typed-array views (no copies). Throws a descriptive error on a stale or truncated file. */
export function parseBinMesh(buf: ArrayBuffer, label = 'PBM1'): { header: BinMeshHeader; arrays: Map<string, { attrs: Map<string, ArrayBufferView>; indices: Uint16Array | Uint32Array }> } {
  if (!LITTLE_ENDIAN) throw new Error(`${label}: big-endian host, the binary data is little-endian`);
  if (buf.byteLength < 8) throw new Error(`${label}: ${buf.byteLength} bytes, not a PBM1 file`);
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== BINMESH_MAGIC) throw new Error(`${label}: not a PBM1 file`);
  const hlen = dv.getUint32(4, true);
  if (8 + hlen > buf.byteLength) throw new Error(`${label}: truncated (header ${hlen} bytes, file ${buf.byteLength})`);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen))) as BinMeshHeader;
  if (header.version !== BINMESH_VERSION) throw new Error(`${label}: PBM1 version ${header.version}, this build reads ${BINMESH_VERSION} — re-run the bake`);
  const arrays = new Map<string, { attrs: Map<string, ArrayBufferView>; indices: Uint16Array | Uint32Array }>();
  const check = (off: number, bytes: number, elem: number, what: string) => {
    if (off % elem !== 0) throw new Error(`${label}: ${what} at byte ${off} is not ${elem}-byte aligned`);
    if (off + bytes > buf.byteLength) throw new Error(`${label}: truncated (${what} needs bytes ${off}..${off + bytes}, file has ${buf.byteLength})`);
  };
  for (const s of header.sections) {
    const attrs = new Map<string, ArrayBufferView>();
    s.attrs.forEach((a, k) => {
      const count = s.vertexCount * a.size;
      const off = s.attrOffsets[k];
      check(off, count * BYTES[a.type], BYTES[a.type], `${s.name}.${a.name}`);
      const view =
        a.type === 'f32' ? new Float32Array(buf, off, count) :
        a.type === 'u8' ? new Uint8Array(buf, off, count) :
        a.type === 'u16' ? new Uint16Array(buf, off, count) :
        a.type === 'i16' ? new Int16Array(buf, off, count) :
        new Uint32Array(buf, off, count);
      attrs.set(a.name, view);
    });
    const ib = s.indexType === 'u16' ? 2 : 4;
    check(s.indexOffset, s.indexCount * ib, ib, `${s.name}.indices`);
    const indices = s.indexType === 'u16' ? new Uint16Array(buf, s.indexOffset, s.indexCount) : new Uint32Array(buf, s.indexOffset, s.indexCount);
    arrays.set(s.name, { attrs, indices });
  }
  return { header, arrays };
}
