import test from 'node:test';
import assert from 'node:assert/strict';
import { principalAxis } from './bridges.ts';
import type { Ring } from './polygons.ts';

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
