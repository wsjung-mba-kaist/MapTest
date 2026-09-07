import test from 'node:test';
import assert from 'node:assert/strict';
import { armGroup, armPhase, signalState, SIGNAL_CYCLE, SIGNAL_GREEN, SIGNAL_RED, SIGNAL_AMBER } from './signals.js';

test('opposite arms share a group, crossing arms do not', () => {
  assert.equal(armGroup(0, 1), armGroup(0, -1));
  assert.equal(armGroup(1, 0), armGroup(-1, 0));
  assert.notEqual(armGroup(0, 1), armGroup(1, 0));
  // a diagonal arm still gets a definite group and its opposite matches
  assert.equal(armGroup(0.6, 0.8), armGroup(-0.6, -0.8));
});

test('crossing streams never share a green', () => {
  const node = 123;
  const pA = armPhase(node, 0, 1), pB = armPhase(node, 1, 0);
  assert.ok(Math.abs(Math.abs(pA - pB) - 0.5) < 1e-9);
  let bothGreen = 0, anyGreen = 0, reds = 0, ambers = 0;
  for (let t = 0; t < SIGNAL_CYCLE * 3; t += 0.25) {
    const a = signalState(t, pA), b = signalState(t, pB);
    if (a === SIGNAL_GREEN && b === SIGNAL_GREEN) bothGreen++;
    if (a === SIGNAL_GREEN || b === SIGNAL_GREEN) anyGreen++;
    if (a === SIGNAL_RED) reds++;
    if (a === SIGNAL_AMBER) ambers++;
  }
  assert.equal(bothGreen, 0);
  assert.ok(anyGreen > 0 && reds > 0 && ambers > 0);
});

test('state sequence within one cycle is green, amber, red', () => {
  const seq: number[] = [];
  for (let t = 0; t < SIGNAL_CYCLE; t += 1) { const s = signalState(t, 0); if (seq[seq.length - 1] !== s) seq.push(s); }
  assert.deepEqual(seq, [SIGNAL_GREEN, SIGNAL_AMBER, SIGNAL_RED]);
});
