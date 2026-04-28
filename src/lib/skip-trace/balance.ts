import { getSkipTraceProvider } from "./registry";

export type SkipTraceBalance =
  | { available: true; credits: number; tier: "ok" | "low" | "critical" }
  | { available: false; reason: "unconfigured" | "error" };

const CACHE_TTL_MS = 60_000;
let cached: { at: number; value: SkipTraceBalance } | null = null;

export async function getSkipTraceBalance(): Promise<SkipTraceBalance> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  const provider = getSkipTraceProvider();
  if (!provider) {
    const value: SkipTraceBalance = { available: false, reason: "unconfigured" };
    cached = { at: Date.now(), value };
    return value;
  }

  try {
    const credits = await provider.getBalance();
    const tier: "ok" | "low" | "critical" =
      credits < 20 ? "critical" : credits < 100 ? "low" : "ok";
    const value: SkipTraceBalance = { available: true, credits, tier };
    cached = { at: Date.now(), value };
    return value;
  } catch {
    const value: SkipTraceBalance = { available: false, reason: "error" };
    cached = { at: Date.now(), value };
    return value;
  }
}
