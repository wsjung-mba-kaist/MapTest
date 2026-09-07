export type Tick = (dt: number, time: number) => void;

export class Loop {
  private handle = 0;
  private last = 0;
  private readonly ticks: Tick[] = [];
  onRender: () => void = () => {};

  add(t: Tick) { this.ticks.push(t); return () => this.remove(t); }
  remove(t: Tick) { const i = this.ticks.indexOf(t); if (i >= 0) this.ticks.splice(i, 1); }

  private driver: ((cb: ((time: number) => void) | null) => void) | null = null;
  /** `driver` = renderer.setAnimationLoop when WebXR may take over the frame cadence; plain rAF otherwise. */
  start(driver?: (cb: ((time: number) => void) | null) => void) {
    this.last = performance.now();
    this.driver = driver ?? null;
    const frame = (now: number) => {
      if (!this.driver) this.handle = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      const t = now / 1000;
      for (const tick of this.ticks) tick(dt, t);
      this.onRender();
    };
    if (this.driver) this.driver(frame); else this.handle = requestAnimationFrame(frame);
  }
  stop() { if (this.driver) this.driver(null); else cancelAnimationFrame(this.handle); }
}
