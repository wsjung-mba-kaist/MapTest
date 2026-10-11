/**
 * Uniforms every lit material shares: the night factor (0 day .. 1 night), the local hour (which windows are lit,
 * shop opening, far-ring windows) and a wall-clock time for animation. Environment writes `uNight` when the sun
 * moves, App writes `uHour` once per frame and `Buildings` writes `uTime`; the materials only read. Owned here, not
 * by FacadeMaterial, so Environment and GroundMaterial do not have to import the facade module to find them
 * (that import cycle made module load order matter).
 */
export const globalUniforms = {
  uNight: { value: 0 },
  uTime: { value: 0 },
  uHour: { value: 12 },   // local hour: drives which windows are lit and shop opening hours (shared/nightlife.ts)
};
