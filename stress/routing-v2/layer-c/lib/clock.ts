import type { Client } from "pg";

/**
 * Clock guard (A2-RACE-ANALYSIS): the app (JS) clock and the DB clock must agree. Measures
 * |Date.now() - DB now()| and fails fast when it is >= 2 s, or when real time is outside 08:00-21:00
 * in any recipient zone the fixtures use. Never shifts any clock.
 */
export async function assertClockAligned(pg: Client, zones: string[]): Promise<{ skewMs: number; local: Record<string, string> }> {
  const t0 = Date.now();
  const { rows } = await pg.query("select extract(epoch from clock_timestamp()) * 1000 as ms");
  const t1 = Date.now();
  const skewMs = Math.abs(Number(rows[0].ms) - (t0 + t1) / 2);
  const local: Record<string, string> = {};
  for (const z of zones) local[z] = new Intl.DateTimeFormat("en-US", { timeZone: z, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date());
  if (skewMs >= 2000) throw new Error(`clock skew ${Math.round(skewMs)} ms between the app (JS) clock and Postgres; refusing to run`);
  const outside = Object.entries(local).filter(([, hm]) => { const h = Number(hm.slice(0, 2)); return h < 8 || h >= 21; });
  if (outside.length) throw new Error(`real time is outside 08:00-21:00 in ${outside.map(([z, hm]) => `${z} ${hm}`).join(", ")}; run inside business hours (no clock shift)`);
  return { skewMs, local };
}
export const FIXTURE_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"];

/** The quiet fixture zone must really be in quiet hours (outside 08:00-21:00) right now; fail fast otherwise. */
export function assertZoneQuiet(zone: string): string {
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", hour: "2-digit", minute: "2-digit" }).format(new Date());
  const h = Number(hm.slice(0, 2));
  if (h >= 8 && h < 21) throw new Error(`quiet fixture zone ${zone} is in business hours (${hm}); the quiet-hours cases cannot run at skew 0 now`);
  return hm;
}
