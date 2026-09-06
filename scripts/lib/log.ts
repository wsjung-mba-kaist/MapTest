const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s]`;
export const log = {
  info: (...a: unknown[]) => console.log(stamp(), ...a),
  warn: (...a: unknown[]) => console.warn(stamp(), 'WARN', ...a),
  step: (name: string) => console.log(`\n${stamp()} ==== ${name} ====`),
};
