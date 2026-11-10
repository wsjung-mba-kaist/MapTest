/** Simulation clock for the moving city: scalable and freezable (?sim=0 freezes, ?sim=4 runs 4x, ?simt=240 starts at t=240 s — parsed by App). */
export class SimClock {
  time = 0;
  scale = 1;
  /** `scale` 0 freezes; `time` is the start of the simulation clock (both from the URL via App, not read here). */
  constructor(scale = 1, time = 0) { this.scale = Math.max(0, scale); this.time = time; }
  get frozen() { return this.scale === 0; }
  tick(dt: number) { const d = dt * this.scale; this.time += d; return d; }
}
