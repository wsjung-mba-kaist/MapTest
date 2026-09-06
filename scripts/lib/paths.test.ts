import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avoidPiers, buildGraph, makeLoop, type WayIn } from './paths.ts';
import { chainRiver } from './river.ts';
import { classify } from './roadnet.ts';
import { laneOffset, rightNormal } from '../../shared/paths.ts';
import type { Pt } from './polygons.ts';

const street = (id: number, pts: Pt[], tags: Record<string, string> = { highway: 'residential' }): WayIn => ({ id, pts, spec: classify(tags)!, tags });

test('graph splits ways at shared vertices and keeps unique endpoints as nodes', () => {
  const g = buildGraph([
    street(1, [[0, 0], [50, 0], [100, 0]]),
    street(2, [[50, -40], [50, 0], [50, 40]]),
  ], 1000);
  assert.equal(g.nodes.length, 5);          // 4 ends + the crossing
  assert.equal(g.edges.length, 4);          // both ways split at (50,0)
  const cross = g.nodes.find(n => n.x === 50 && n.z === 0)!;
  assert.equal(cross.edges.length, 4);
});

test('ways leaving the box are cut at the boundary and the cut node is flagged', () => {
  const g = buildGraph([street(1, [[0, 0], [200, 0]])], 100);
  assert.equal(g.edges.length, 1);
  const end = g.edges[0].verts[g.edges[0].verts.length - 1];
  assert.equal(Math.round(end[0]), 100);
  assert.ok(g.nodes[g.edges[0].b].boundary);
});

test('right normal of a north-heading segment points east', () => {
  const [nx, nz] = rightNormal(0, -1); // north = -z
  assert.equal(nx, 1); assert.equal(nz, 0);
});

test('lane offsets: forward lanes right of the centre, one-way lanes centred', () => {
  assert.ok(laneOffset(1, 1, 3, 0, false, 0, 1) > 0);
  assert.ok(laneOffset(1, 1, 3, 0, false, 0, -1) < 0);
  assert.equal(laneOffset(2, 0, 3, 0, true, 0, 1), -1.5);
  assert.equal(laneOffset(2, 0, 3, 0, true, 1, 1), 1.5);
});

test('classify: one-way residential gets one lane and parking room; primary gets 2+2 and none', () => {
  const r = classify({ highway: 'residential', oneway: 'yes' })!;
  assert.equal(r.lanesF, 1); assert.equal(r.lanesB, 0); assert.ok(r.parkingSides >= 1); assert.ok(r.sideL && r.sideR);
  const p = classify({ highway: 'primary' })!;
  assert.equal(p.lanesF + p.lanesB, 4); assert.equal(p.parkingSides, 0);
  assert.equal(classify({ highway: 'footway', footway: 'sidewalk' })!.walkCentre, true);
  assert.equal(classify({ highway: 'corridor' }), null);
  assert.equal(classify({ highway: 'service', service: 'parking_aisle' }), null);
});

test('river: ways chain downstream and a fork becomes a second arm', () => {
  const arms = chainRiver([
    { id: 1, pts: [[100, 0], [50, 0]] },
    { id: 2, pts: [[50, 0], [0, 0], [-100, 0]] },
    { id: 3, pts: [[50, 0], [0, 20]] },
  ]);
  assert.equal(arms.length, 2);
  assert.equal(arms[0].length, 4);          // main arm is the longer one
  assert.deepEqual(arms[0][0], [100, 0]);
});

test('boat loop is closed and stays clear of piers', () => {
  const centre: Pt[] = []; for (let x = -300; x <= 300; x += 30) centre.push([x, 0]);
  const piers = [{ cx: 0, cz: 12, dx: 0, dz: 1, halfL: 2.25, halfW: 10, name: 'test' }]; // pier right on the downstream lane
  const loop = makeLoop(centre, 12, piers);
  const first = loop[0], last = loop[loop.length - 1];
  assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < 30);
  let minD = Infinity;
  for (const p of loop) minD = Math.min(minD, Math.hypot(p[0] - 0, p[1] - 12));
  assert.ok(minD >= 8, `min distance to pier ${minD.toFixed(1)}`);
  const nudged = avoidPiers([[-120, 12], [-60, 12], [0, 12], [60, 12], [120, 12]], piers);
  assert.ok(Math.abs(nudged[2][1] - 12) > 8);
  assert.equal(nudged[0][1], 12); // beyond plateau + lead-out the lane is untouched
});
