declare module 'osmtogeojson' {
  import type { FeatureCollection } from 'geojson';
  interface Options { flatProperties?: boolean; uninterestingTags?: Record<string, boolean> | ((tags: Record<string, string>, ignoreTags: Record<string, string>) => boolean); polygonFeatures?: unknown; verbose?: boolean }
  function osmtogeojson(data: unknown, options?: Options): FeatureCollection;
  export default osmtogeojson;
}
declare module 'earcut' {
  function earcut(vertices: ArrayLike<number>, holes?: number[], dimensions?: number): number[];
  namespace earcut { function deviation(vertices: ArrayLike<number>, holes: number[] | undefined, dimensions: number, triangles: number[]): number; function flatten(data: number[][][]): { vertices: number[]; holes: number[]; dimensions: number } }
  export default earcut;
}
