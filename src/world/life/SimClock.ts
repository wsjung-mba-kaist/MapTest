/** Simulation clock for the moving city: scalable and freezable via URL (?sim=0 freezes, ?sim=4 runs 4x, ?simt=240 starts at t=240 s). */
export class SimClock {
  time = 0;
  scale = 1;
  constructor() {
    if (typeof location !== 'undefined') {
      const q = new URLSearchParams(location.search);
      if (q.has('sim')) this.scale = Math.max(0, parseFloat(q.get('sim')!) || 0);
      if (q.has('simt')) this.time = parseFloat(q.get('simt')!) || 0;
    }
  }
  get frozen() { return this.scale === 0; }
  tick(dt: number) { const d = dt * this.scale; this.time += d; return d; }
}
