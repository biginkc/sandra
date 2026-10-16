// Lazy env reader for the Norma call queue. Anything invalid or missing fails closed: enabled=false + problems.

export type NormaQueueConfig = {
  enabled: boolean;
  maxConcurrent: number | null;
  dailyCap: number | null;
  capTz: string;
  problems: string[];
};

export const DEFAULT_NORMA_QUEUE_CAP_TZ = "America/Chicago";

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);

function parsePositiveInt(raw: string | undefined, name: string, problems: string[]): number | null {
  if (raw === undefined) return null;
  const value = raw.trim();
  if (!/^[1-9][0-9]*$/.test(value)) {
    problems.push(`${name} must be a positive integer`);
    return null;
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    problems.push(`${name} is out of range`);
    return null;
  }
  return n;
}

function isValidZone(zone: string): boolean {
  // Region/City IANA names only: Intl also accepts legacy abbreviations such as "CST", which are ambiguous.
  if (!zone.includes("/") && zone !== "UTC") return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function readNormaQueueConfig(env: Record<string, string | undefined>): NormaQueueConfig {
  const problems: string[] = [];
  const flagOn = TRUE_VALUES.has((env.NORMA_QUEUE_ENABLED ?? "").trim().toLowerCase());

  const maxConcurrent = parsePositiveInt(env.NORMA_QUEUE_MAX_CONCURRENT, "NORMA_QUEUE_MAX_CONCURRENT", problems);
  const dailyCap = parsePositiveInt(env.NORMA_QUEUE_DAILY_CAP, "NORMA_QUEUE_DAILY_CAP", problems);
  if (flagOn && env.NORMA_QUEUE_MAX_CONCURRENT === undefined) problems.push("NORMA_QUEUE_MAX_CONCURRENT is required");
  if (flagOn && env.NORMA_QUEUE_DAILY_CAP === undefined) problems.push("NORMA_QUEUE_DAILY_CAP is required");

  const rawTz = (env.NORMA_QUEUE_CAP_TZ ?? "").trim();
  let capTz = DEFAULT_NORMA_QUEUE_CAP_TZ;
  if (rawTz) {
    if (isValidZone(rawTz)) capTz = rawTz;
    else problems.push("NORMA_QUEUE_CAP_TZ is not a valid IANA zone");
  }

  return { enabled: flagOn && problems.length === 0, maxConcurrent, dailyCap, capTz, problems };
}
