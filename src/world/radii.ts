/**
 * Streaming / activation radii (metres) of the world layers, in one place because they depend on each other:
 * facade details must sit inside the LOD0 radius, sidewalk walkables must cover the player's reach, far traffic must
 * start where the simulated cars stop, and the mobile preset has to scale them together. Each layer reads its default
 * from here; App's touch preset overrides through the same fields.
 */
export const RADII = {
  /** buildings: LOD0 ↔ LOD1 swap, shadow casting off, lazy facade details (built nearer, dropped farther) */
  buildingLod: 800,
  buildingShadow: 600,
  buildingDetail: 520,
  buildingDetailUnload: 520 + 350,
  /** sidewalk slabs: load / unload, and the band in which they are collision walkables */
  streetsLoad: 620,
  streetsUnload: 900,
  streetsWalk: 330,
  streetsWalkUnload: 330 + 120,
  /** road markings */
  marksLoad: 460,
  marksUnload: 720,
  /** tree LOD swap (the cell test squares this × 1.6, so the effective radius is ≈ 240 × 1.26) */
  treesLod: 240,
  /** moving city: edges activated around the player, agents despawn `despawn` beyond that */
  lifeWalk: 220,
  lifeDrive: 350,
  lifeDespawn: 60,
  /** hero model LOD when the model's own json does not say */
  heroLod: 900,
} as const;

/** The far-traffic sprite band starts just inside where the simulated cars stop and ends past their despawn ring. */
export const FAR_TRAFFIC_NEAR = RADII.lifeDrive - 90;   // 260
export const FAR_TRAFFIC_FAR = RADII.lifeDrive + RADII.lifeDespawn + 10;   // 420

/** Touch / mobile preset: details and tree LOD pulled in (see App.boot). */
export const MOBILE_RADII = { buildingDetail: 320, treesLod: 160 } as const;
