export type Tick = (dt: number, time: number) => void;

export class Loop {
  private handle = 0;
  private last = 0;
  private readonly ticks: Tick[] = [];
  onRender: () => void = () => {};

  add(t: Tick) { this.ticks.push(t); return () => this.remove(t); }
  remove(t: Tick) { const i = this.ticks.indexOf(t); if (i >= 0) this.ticks.splice(i, 1); }

  start() {
    this.last = performance.now();
    const frame = (now: number) => {
      this.handle = requestAnimationFrame(frame);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      const t = now / 1000;
      for (const tick of this.ticks) tick(dt, t);
      this.onRender();
    };
    this.handle = requestAnimationFrame(frame);
  }
  stop() { cancelAnimationFrame(this.handle); }
}
