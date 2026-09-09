/**
 * Automatic quality: after the start the runtime samples frame times for a few seconds and, when the machine is
 * clearly too slow, steps the post-processing preset down one notch (never up, once per session) so the walk stays
 * smooth without the user finding `?quality=`. Pure so the decision is testable.
 */
export type QualityLevel = 'high' | 'medium' | 'low';
export const QUALITY_STEPS: readonly QualityLevel[] = ['high', 'medium', 'low'];

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

export interface QualityDecision { quality: QualityLevel; pixelRatio?: 0.75; changed: boolean; p50: number }

/**
 * `slowMs` is the median frame time that counts as too slow (40 ms = 25 fps). At `low` a still-slow machine also
 * gets a 0.75 pixel ratio. Fewer than `minSamples` frames means no decision yet.
 */
export function pickQuality(frameMs: number[], current: QualityLevel, opts: { slowMs?: number; minSamples?: number } = {}): QualityDecision {
  const slowMs = opts.slowMs ?? 40, minSamples = opts.minSamples ?? 60;
  const p50 = percentile(frameMs, 0.5);
  if (frameMs.length < minSamples || !(p50 > slowMs)) return { quality: current, changed: false, p50 };
  const i = QUALITY_STEPS.indexOf(current);
  if (i < QUALITY_STEPS.length - 1) return { quality: QUALITY_STEPS[i + 1], changed: true, p50 };
  return { quality: current, pixelRatio: 0.75, changed: true, p50 };
}
