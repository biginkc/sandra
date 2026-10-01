 
// Reads harness configuration from environment variables. Never logs values.

export interface Limits {
  maxAttempts: number;
  maxSpendUsd: number;
  ringTimeoutSecs: number;
  maxLegSecs: number;
  f7DeadlineSecs: number;
  /** Conservative estimate only. Provider-side caps are a backstop, not the control. */
  estCostPerLegMinuteUsd: number;
  /** Daily spend cap set on the enabled test outbound profile. */
  profileDailyCapUsd: number;
  profileConcurrentLimit: number;
}

export interface Config {
  apiKey: string;
  testPhones: string[];
  callerId: string;
  publicBaseUrl: string;
  publicKey: string;
  devSipEndpoints: string[];
  limits: Limits;
}

export const E164 = /^\+[1-9]\d{6,14}$/;

export const DEFAULT_LIMITS: Limits = {
  maxAttempts: 60,
  maxSpendUsd: 25,
  ringTimeoutSecs: 30,
  maxLegSecs: 180,
  f7DeadlineSecs: 30,
  estCostPerLegMinuteUsd: 0.02,
  profileDailyCapUsd: 10,
  profileConcurrentLimit: 2,
};

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, dflt: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${key} must be a positive number`);
  return n;
}

export function parsePhones(raw: string | undefined, key: string): string[] {
  const list = (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const p of list) {
    if (!E164.test(p)) throw new Error(`${key} contains a value that is not E.164`);
  }
  return list;
}

export function loadLimits(env: Env = process.env): Limits {
  const d = DEFAULT_LIMITS;
  const limits: Limits = {
    maxAttempts: num(env, "DIRECT_CALL_MAX_ATTEMPTS", d.maxAttempts),
    maxSpendUsd: num(env, "DIRECT_CALL_MAX_SPEND_USD", d.maxSpendUsd),
    ringTimeoutSecs: num(env, "DIRECT_CALL_RING_TIMEOUT_SECS", d.ringTimeoutSecs),
    maxLegSecs: num(env, "DIRECT_CALL_MAX_LEG_SECS", d.maxLegSecs),
    f7DeadlineSecs: num(env, "DIRECT_CALL_F7_DEADLINE_SECS", d.f7DeadlineSecs),
    estCostPerLegMinuteUsd: num(env, "DIRECT_CALL_EST_COST_PER_LEG_MIN_USD", d.estCostPerLegMinuteUsd),
    profileDailyCapUsd: num(env, "DIRECT_CALL_PROFILE_DAILY_CAP_USD", d.profileDailyCapUsd),
    profileConcurrentLimit: num(env, "DIRECT_CALL_PROFILE_CONCURRENT_LIMIT", d.profileConcurrentLimit),
  };
  // Approved envelope (D2): env may tighten but never loosen.
  if (limits.maxAttempts > d.maxAttempts) throw new Error("DIRECT_CALL_MAX_ATTEMPTS may not exceed 60");
  if (limits.maxSpendUsd > d.maxSpendUsd) throw new Error("DIRECT_CALL_MAX_SPEND_USD may not exceed 25");
  if (limits.maxLegSecs > d.maxLegSecs) throw new Error("DIRECT_CALL_MAX_LEG_SECS may not exceed 180");
  if (limits.ringTimeoutSecs > d.ringTimeoutSecs) throw new Error("DIRECT_CALL_RING_TIMEOUT_SECS may not exceed 30");
  if (limits.maxLegSecs < 30) throw new Error("time_limit_secs must be at least 30");
  return limits;
}

export function loadConfig(env: Env = process.env): Config {
  const apiKey = env.TELNYX_API_KEY ?? "";
  if (!apiKey) throw new Error("TELNYX_API_KEY is not set");
  const testPhones = parsePhones(env.DIRECT_CALL_TEST_PHONES, "DIRECT_CALL_TEST_PHONES");
  if (testPhones.length === 0) throw new Error("DIRECT_CALL_TEST_PHONES is not set");
  const callerId = (env.DIRECT_CALL_CALLER_ID ?? "").trim();
  if (!E164.test(callerId)) throw new Error("DIRECT_CALL_CALLER_ID must be set and E.164");
  const publicBaseUrl = (env.DIRECT_CALL_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(publicBaseUrl)) throw new Error("DIRECT_CALL_PUBLIC_BASE_URL must be an https tunnel origin");
  const publicKey = env.TELNYX_PUBLIC_KEY ?? "";
  if (!publicKey) throw new Error("TELNYX_PUBLIC_KEY is not set");
  const devSipEndpoints = (env.DIRECT_CALL_DEV_SIP_ENDPOINTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return { apiKey, testPhones, callerId, publicBaseUrl, publicKey, devSipEndpoints, limits: loadLimits(env) };
}

export function maskPhone(p: string): string {
  return `+***${p.slice(-4)}`;
}

/** Redacted description safe to print. Never includes secret or phone values. */
export function describeConfig(c: Config): string {
  const host = new URL(c.publicBaseUrl).host.replace(/^[^.]+/, "***");
  return [
    "TELNYX_API_KEY: set (redacted)",
    `TELNYX_PUBLIC_KEY: set (redacted)`,
    `test phones: ${c.testPhones.length} configured`,
    `caller ID: ${maskPhone(c.callerId)}`,
    `public base: https://${host}`,
    `dev SIP endpoints: ${c.devSipEndpoints.length}`,
    `limits: ${JSON.stringify(c.limits)}`,
  ].join("\n");
}
