import { DATA_URL, fetchJson } from './DataLoader';
import type { Landmark, LandmarksData } from '../../shared/layout';
import { bearingDeg, landmarkAt, nearestLandmark, sortByDistance } from '../../shared/landmarks';

/** The eight historical viewpoints, used when landmarks.json has not been baked (`npm run bake:landmarks`). */
const FALLBACK: [number, string, string, string, number, number, number?][] = [
  [1, 'trocadero', '트로카데로', 'Trocadéro', -480, -409], [2, 'pont-iena', '이에나 다리', "Pont d'Iéna", -190, -200],
  [3, 'eiffel', '에펠탑', 'Tour Eiffel', 0, 70], [4, 'champ-de-mars', '샹드마르스', 'Champ de Mars', 290, 380],
  [5, 'ecole-militaire', '에콜 밀리테르', 'École Militaire', 600, 760], [6, 'pont-bir-hakeim', '비르아켐 다리', 'Pont de Bir-Hakeim', -540, 380],
  [7, 'quai-branly', '케 브랑리', 'Quai Branly', 260, -80], [8, 'eiffel-deck', '에펠탑 2층', 'Tour Eiffel · 2e étage', -42, -30, 1],
];

/** Curated sites (names, descriptions, photos, landing spots) and the proximity queries over them. */
export class Landmarks {
  list: Landmark[] = [];
  readonly byId = new Map<string, Landmark>();
  credits: string[] = [];
  /** false = built-in fallback list (no descriptions / photos) */
  baked = false;

  async load() {
    try {
      const d = await fetchJson<LandmarksData>(`${DATA_URL}/landmarks.json`);
      this.list = d.landmarks; this.credits = d.credits ?? []; this.baked = true;
    } catch (e) {
      console.warn('landmarks.json missing (npm run bake:landmarks): using the built-in viewpoints', e);
      this.list = FALLBACK.map(([hotkey, id, ko, fr, x, z, deck]) => ({
        id, category: 'monument', hotkey, hidden: !!deck, x, z, lon: 0, lat: 0, radius: deck ? 0 : 80,
        view: { x, z, yaw: bearingDeg(x, z, 0, 0), deck }, name: { ko, fr, en: fr }, short: ko, links: {},
      }));
    }
    for (const l of this.list) this.byId.set(l.id, l);
  }

  get visible() { return this.list.filter(l => !l.hidden); }
  byHotkey(n: number) { return this.list.find(l => l.hotkey === n) ?? null; }
  at(x: number, z: number) { return landmarkAt(this.list, x, z); }
  nearest(x: number, z: number) { return nearestLandmark(this.list, x, z); }
  sorted(x: number, z: number) { return sortByDistance(this.visible, x, z); }
}
