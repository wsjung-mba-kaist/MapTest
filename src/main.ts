import { App } from './core/App';

// CanvasRenderingContext2D.roundRect is missing in Firefox < 116 / Safari < 16; the minimap, compass and landmark
// labels all draw with it, so a missing method turned a cosmetic corner into a hard boot failure.
if (typeof CanvasRenderingContext2D !== 'undefined' && !CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x: number, y: number, w: number, h: number, r: number | DOMPointInit | (number | DOMPointInit)[] = 0) {
    const rr = Math.min(typeof r === 'number' ? r : Array.isArray(r) ? Number(r[0]) || 0 : 0, w / 2, h / 2);
    this.moveTo(x + rr, y); this.arcTo(x + w, y, x + w, y + h, rr); this.arcTo(x + w, y + h, x, y + h, rr);
    this.arcTo(x, y + h, x, y, rr); this.arcTo(x, y, x + w, y, rr); this.closePath();
  };
}

const canvas = document.getElementById('app') as HTMLCanvasElement;
const app = new App(canvas);
Object.assign(window, { app });   // console / screenshot automation: window.app
app.boot().catch(err => {
  console.error(err);
  app.hud.fail(err instanceof Error ? err.message : String(err), true);
});
