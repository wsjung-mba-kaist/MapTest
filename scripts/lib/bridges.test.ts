import test from 'node:test';
import assert from 'node:assert/strict';
import { deckApron, principalAxis } from './bridges.ts';
import { area, orient, unionAll, type Pt, type Ring } from './polygons.ts';

/**
 * Piers and arch springings are laid out across [-half, +half] about the axis centre, so the centre has to be the
 * middle of the deck. It used to be the unweighted vertex mean with the measured midpoints discarded, which slid
 * whole pier rows along real bridges by up to 17.9 m and pushed spandrel walls up to 7.8 m off the deck edges.
 */

/** Rectangle centred at (cx, cz), running `len` along `ang` and `wid` across it, with `extra` vertices on one edge. */
function deck(cx: number, cz: number, len: number, wid: number, ang: number, extraOnOneEdge = 0): Ring {
  const dx = Math.cos(ang), dz = Math.sin(ang);
  const nx = -dz, nz = dx;
  const at = (t: number, w: number): [number, number] => [cx + dx * t + nx * w, cz + dz * t + nz * w];
  const h = len / 2, k = wid / 2;
  const r: Ring = [at(-h, -k), at(h, -k), at(h, k)];
  // Crowd one long edge with vertices, the way a detailed kerb or a buffered polyline's joint discs do.
  for (let i = extraOnOneEdge; i > 0; i--) r.push(at(-h + (len * i) / (extraOnOneEdge + 1), k));
  r.push(at(-h, k));
  return r;
}

test('the axis centre is the middle of the deck, not the vertex mean', () => {
  const ang = 0.4;
  for (const extra of [0, 3, 20]) {
    const ax = principalAxis(deck(120, -35, 160, 22, ang, extra));
    assert.ok(Math.hypot(ax.cx - 120, ax.cz - -35) < 0.05, `extra=${extra}: centre drifted to ${ax.cx.toFixed(2)}, ${ax.cz.toFixed(2)}`);
    assert.ok(Math.abs(ax.half - 80) < 0.05, `extra=${extra}: half ${ax.half}`);
    assert.ok(Math.abs(ax.width - 22) < 0.05, `extra=${extra}: width ${ax.width}`);
  }
});

test('a pier row laid out across [-half, +half] lands inside the deck', () => {
  const ang = -0.9, len = 150, wid = 18;
  const ring = deck(-400, 260, len, wid, ang, 12);
  const ax = principalAxis(ring);
  // The same arithmetic pierBoxes uses: evenly spaced supports inside the span.
  for (const t of [-ax.half + 10, -ax.half / 2, 0, ax.half / 2, ax.half - 10]) {
    const px = ax.cx + ax.dx * t, pz = ax.cz + ax.dz * t;
    // Distance from the deck's own centre line, measured across the axis.
    const across = Math.abs(-(px - -400) * Math.sin(ang) + (pz - 260) * Math.cos(ang));
    assert.ok(across < 0.05, `t=${t}: pier sits ${across.toFixed(2)} m off the centre line`);
    const along = Math.abs((px - -400) * Math.cos(ang) + (pz - 260) * Math.sin(ang));
    assert.ok(along <= len / 2 + 1e-6, `t=${t}: pier is ${along.toFixed(2)} m from centre, past the ${len / 2} m end`);
  }
});

test('the axis follows the long side whichever way the deck is turned', () => {
  for (const ang of [0, 0.3, Math.PI / 2 - 0.2, 1.9, -1.1]) {
    const ax = principalAxis(deck(0, 0, 200, 15, ang));
    const dot = Math.abs(ax.dx * Math.cos(ang) + ax.dz * Math.sin(ang));
    assert.ok(dot > 0.999, `ang=${ang}: axis off by ${(Math.acos(Math.min(1, dot)) * 180 / Math.PI).toFixed(2)} deg`);
    assert.ok(Math.abs(ax.half - 100) < 0.05, `ang=${ang}: half ${ax.half}`);
  }
});

/**
 * The apron that carries a deck from its abutment to the road has to continue the deck, not the carriageway. It used
 * to be `w / 2` either side of the chosen way with `w` the outline's overall extent: on the Pont d'Iena (156 m by
 * 36.5 m, the way 8.8 m off the middle, extent 39.8 m) the slab at each end stood 10.4 m proud on one side and 7.2 m
 * short on the other.
 */

/** `p` in the frame of a deck centred at (cx, cz) and turned `ang`: [along, across]. */
function inDeck(p: Pt, cx: number, cz: number, ang: number): [number, number] {
  const dx = Math.cos(ang), dz = Math.sin(ang);
  return [(p[0] - cx) * dx + (p[1] - cz) * dz, -(p[0] - cx) * dz + (p[1] - cz) * dx];
}

test('the apron is as wide as the deck wherever the carriageway runs across it', () => {
  const cx = 40, cz = -90, len = 156, wid = 36.5, reach = 10;
  for (const ang of [0, 0.77, -1.2, 2.6]) for (const off of [-8.8, 0, 12]) for (const dir of [1, -1]) {
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const ring = orient(deck(cx, cz, len, wid, ang), false);
    const end: Pt = [cx + dx * dir * len / 2 - dz * off, cz + dz * dir * len / 2 + dx * off];
    const apron = deckApron([ring], end, dx * dir, dz * dir, reach, 39.8).map(p => inDeck(p, cx, cz, ang));
    const across = apron.map(p => p[1]), along = apron.map(p => p[0] * dir);
    const where = `ang=${ang} off=${off} dir=${dir}`;
    assert.ok(Math.abs(Math.max(...across) - wid / 2) < 0.02, `${where}: reaches ${Math.max(...across).toFixed(2)}, deck edge at ${wid / 2}`);
    assert.ok(Math.abs(Math.min(...across) + wid / 2) < 0.02, `${where}: reaches ${Math.min(...across).toFixed(2)}, deck edge at ${-wid / 2}`);
    assert.ok(Math.abs(Math.max(...along) - (len / 2 + reach)) < 1e-6, `${where}: runs out to ${Math.max(...along).toFixed(2)}`);
    assert.ok(Math.min(...along) < len / 2 - 2, `${where}: starts ${Math.min(...along).toFixed(2)}, not inside the deck`);
  }
});

test('deck and aprons union into one outline with straight sides', () => {
  const cx = -177, cz = -160, len = 156, wid = 36.5, off = -8.8, ang = 0.769, reach = 11;
  const dx = Math.cos(ang), dz = Math.sin(ang);
  const ring = orient(deck(cx, cz, len, wid, ang), false);
  const aprons = [1, -1].map(dir => [deckApron([ring], [cx + dx * dir * len / 2 - dz * off, cz + dz * dir * len / 2 + dx * off], dx * dir, dz * dir, reach, 39.8)]);
  const merged = unionAll([[ring], ...aprons]);
  assert.equal(merged.length, 1);
  const outline = merged[0][0].map(p => inDeck(p, cx, cz, ang));
  // nothing sticks out past the deck's sides, and the deck has grown by exactly its own width times the reach
  for (const [t, w] of outline) assert.ok(Math.abs(w) < wid / 2 + 0.02, `vertex at along=${t.toFixed(2)} sits ${w.toFixed(2)} across, deck edge at ${wid / 2}`);
  assert.ok(Math.abs(area(merged[0][0]) - (len + 2 * reach) * wid) < 2, `area ${area(merged[0][0]).toFixed(1)}`);
});

test('a skewed abutment does not narrow the apron', () => {
  // The end face crosses the road at 63 degrees instead of 90, so 3 m in one of the two rays lands on the end face.
  const h = 60, k = 10, skew = 10, reach = 8;
  for (const ang of [0, 1.1, -2.3]) {
    const dx = Math.cos(ang), dz = Math.sin(ang);
    const at = (t: number, w: number): Pt => [dx * t - dz * w, dz * t + dx * w];
    const ring = orient([at(-h, -k), at(h - skew, -k), at(h, k), at(-h, k)], false);
    const apron = deckApron([ring], at(h - skew / 2, 0), dx, dz, reach, 2 * k + 3).map(p => inDeck(p, 0, 0, ang));
    const across = apron.map(p => p[1]);
    assert.ok(Math.abs(Math.max(...across) - k) < 0.02 && Math.abs(Math.min(...across) + k) < 0.02, `ang=${ang}: spans ${Math.min(...across).toFixed(2)} .. ${Math.max(...across).toFixed(2)}`);
    assert.ok(Math.abs(Math.max(...apron.map(p => p[0])) - (h - skew / 2 + reach)) < 1e-6);
  }
});

test('a way that overshoots the outline keeps the centred apron', () => {
  // No station lands on the deck, so there is no edge to find: half the given width either side of the way.
  const ring = orient(deck(0, 0, 80, 14, 0), false);
  const apron = deckApron([ring], [60, 2], 1, 0, 9, 16);
  const across = apron.map(p => p[1]), along = apron.map(p => p[0]);
  assert.ok(Math.abs(Math.max(...across) - 10) < 1e-9 && Math.abs(Math.min(...across) + 6) < 1e-9, `spans ${Math.min(...across)} .. ${Math.max(...across)}`);
  assert.ok(Math.abs(Math.min(...along) - 57) < 1e-9 && Math.abs(Math.max(...along) - 69) < 1e-9, `runs ${Math.min(...along)} .. ${Math.max(...along)}`);
});
