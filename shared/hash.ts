/** Deterministic integer hashes shared by the bake and the runtime (and, for ihash, by GLSL). */

/** 32-bit mix of up to four integers -> [0, 1). Stable across platforms (only imul/xor/shift). */
export function hash32(a: number, b = 0, c = 0, d = 0): number {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul((b | 0) + 0x7f4a7c15, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae3d) ^ Math.imul((c | 0) + 0x165667b1, 0x27d4eb2f);
  h ^= Math.imul((d | 0) + 0x9e3779b1, 0x85ebca77);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Two-integer hash -> [0, 1) with a bit-exact GLSL twin:
 *   float ihash(uint a, uint b) { uint h = a * 2654435761u ^ b * 2246822519u; h ^= h >> 13u; h *= 3266489917u; h ^= h >> 16u; return float(h & 0xFFFFu) / 65536.0; }
 */
export function ihash(a: number, b: number): number {
  let h = (Math.imul(a >>> 0, 2654435761) ^ Math.imul(b >>> 0, 2246822519)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 3266489917) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h & 0xffff) / 65536;
}
