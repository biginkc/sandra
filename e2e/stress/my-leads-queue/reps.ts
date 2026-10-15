/** Strict positive-integer parsing for rep counts read from the environment: 0, negatives, fractions and NaN are refused, never run as zero work. */
export function parsePositiveInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer; got ${JSON.stringify(raw)}`);
  return n;
}

/** Full-run volume floors (stress design v1): a full run below these is not the gate. */
export const FULL_FLOORS = { repeats: 20, raceReps: 200, bindReps: 20, scaleSamples: 10 } as const;
