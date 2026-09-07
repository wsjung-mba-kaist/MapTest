import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrossings, pedestriansMayCross, type CrossingGraph, CROSSING_FLAG, SIGNAL_NODE } from './crossings.js';
import { armPhase, signalState, SIGNAL_GREEN, SIGNAL_RED } from './signals.js';

/**
 * Nodes: 0 --road-- 1 --road-- 2(junction, SIGNAL)   along +x, 1 is 12 m before the junction
 *        3 --crossing-- 1 --crossing-- 4              along +z (kerb to kerb through the road node)
 */
function graph(): CrossingGraph {
  const nodes = [[-40, 0, 0], [-12, 0, 0], [0, 0, 0], [-12, 0, -6], [-12, 0, 6]];
  const edges: { a: number; b: number; flags: number; drive: boolean }[] = [
    { a: 0, b: 1, flags: 0, drive: true }, { a: 1, b: 2, flags: 0, drive: true },
    { a: 3, b: 1, flags: CROSSING_FLAG, drive: false }, { a: 1, b: 4, flags: CROSSING_FLAG, drive: false },
    { a: 2, b: 5, flags: 0, drive: true }, { a: 6, b: 2, flags: 0, drive: true },   // the junction's other arms (nodes 5, 6 north/south)
  ];
  nodes.push([0, 0, -30], [0, 0, 30]);
  const vPos: number[] = [], eV0: number[] = [], eNv: number[] = [];
  for (const e of edges) { eV0.push(vPos.length / 3); vPos.push(...nodes[e.a], ...nodes[e.b]); eNv.push(2); }
  const adj = nodes.map(() => [] as number[]);
  edges.forEach((e, i) => { adj[e.a].push(i); adj[e.b].push(i); });
  return {
    eLen: edges.map(e => Math.hypot(nodes[e.b][0] - nodes[e.a][0], nodes[e.b][2] - nodes[e.a][2])),
    eFlags: edges.map(e => e.flags), eA: edges.map(e => e.a), eB: edges.map(e => e.b), eV0, eNv, vPos,
    nodeCount: nodes.length,
    incident: (n, out = []) => { out.length = 0; out.push(...adj[n]); return out; },
    nodeFlag: (n, f) => n === 2 && f === SIGNAL_NODE,
    drivable: e => edges[e].drive,
  };
}

test('crossing halves map to the road node and inherit the junction arm phase', () => {
  const t = buildCrossings(graph());
  assert.equal(t.count, 1);
  assert.equal(t.signalled, 1);
  assert.equal(t.byEdge[2], 1); assert.equal(t.byEdge[3], 1); assert.equal(t.byEdge[0], -1);
  // cars travelling 1 -> 2 enter the junction heading +x
  assert.ok(Math.abs(t.phase[1] - armPhase(2, 1, 0)) < 1e-6);
  // cars arriving at node 1 from either side pass the crossing
  assert.equal(t.atEnd[0 * 2 + 1], 1);   // edge 0 arriving at b = 1
  assert.equal(t.atEnd[1 * 2 + 0], 1);   // edge 1 arriving at a = 1
  assert.equal(t.atEnd[1 * 2 + 1], -1);  // arriving at the junction itself: no crossing there
});

test('pedestrians walk exactly when the protected arm is red; unsignalled crossings are always open', () => {
  const ph = armPhase(2, 1, 0);
  let agree = 0, n = 0;
  for (let time = 0; time < 64; time += 0.5) { n++; if (pedestriansMayCross(time, ph) === (signalState(time, ph) === SIGNAL_RED)) agree++; }
  assert.equal(agree, n);
  assert.ok([0, 8, 16, 24].some(tm => signalState(tm, ph) === SIGNAL_GREEN && !pedestriansMayCross(tm, ph)));
  assert.equal(pedestriansMayCross(123, -1), true);
});
