import type { NormaEnv } from "./config";

const EXPLICIT_RELEASE = new Set(["0", "false", "no", "off"]);

/** Unset preserves normal operation; a present malformed value holds safely. */
export function readNormaMaintenanceHold(env: NormaEnv = process.env): boolean {
  const raw = env.NORMA_MAINTENANCE_HOLD;
  return raw !== undefined && !EXPLICIT_RELEASE.has(raw.trim().toLowerCase());
}
