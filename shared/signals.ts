import { hash32 } from './hash.js';

/**
 * Traffic-signal timing shared by the signal heads (src/world/life/Signals.ts) and the cars that obey them
 * (Traffic.ts). A junction runs a 32 s cycle; its arms fall into two groups by bearing (north-south-ish and
 * east-west-ish) and the second group is half a cycle behind, so crossing streams never share a green.
 */
export const SIGNAL_CYCLE = 32;      // seconds
export const GREEN_END = 0.44;       // fraction of the cycle
export const AMBER_END = 0.50;
export const SIGNAL_RED = 0, SIGNAL_AMBER = 1, SIGNAL_GREEN = 2;

/** Base phase of a junction in [0,1), stable per node id. */
export function junctionPhase(node: number): number { return hash32(node, 41); }

/** 0 for arms whose direction of travel into the junction is roughly along +-z, 1 for roughly +-x. */
export function armGroup(ux: number, uz: number): 0 | 1 {
  const q = Math.round(Math.atan2(ux, uz) / (Math.PI / 2));   // nearest quarter turn, -2..2
  return (Math.abs(q) % 2) as 0 | 1;
}

/** Phase of one arm: the junction phase, plus half a cycle for the second group. */
export function armPhase(node: number, ux: number, uz: number): number {
  const p = junctionPhase(node) + armGroup(ux, uz) * 0.5;
  return p - Math.floor(p);
}

/** State of an arm with `phase` at simulation time `time` (seconds). */
export function signalState(time: number, phase: number): number {
  const t = time / SIGNAL_CYCLE + phase;
  const f = t - Math.floor(t);
  return f < GREEN_END ? SIGNAL_GREEN : f < AMBER_END ? SIGNAL_AMBER : SIGNAL_RED;
}
