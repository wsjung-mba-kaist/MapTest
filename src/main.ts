import { App } from './core/App';

const canvas = document.getElementById('app') as HTMLCanvasElement;
const app = new App(canvas);
app.boot().catch(err => {
  console.error(err);
  app.hud.fail(err instanceof Error ? err.message : String(err));
});
