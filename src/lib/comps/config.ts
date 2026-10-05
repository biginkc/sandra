import { ConfigurationError } from "@/lib/errors/classes";

import { createAttomProvider } from "./providers/attom";
import { createFixtureProvider } from "./providers/fixture";
import type { CompProvider } from "./types";

export const DEFAULT_ATTOM_BASE_URL = "https://api.gateway.attomdata.com";

/**
 * Resolve the comps provider from the environment (seam S2, mirrors `getSkipTraceProvider`).
 * `COMPS_PROVIDER` unset or `off` → null (feature off). `attom` needs `ATTOM_API_KEY`.
 * `fixture` is refused in production (`VERCEL_ENV=production`) with no override: invented
 * numbers must never reach the rep.
 */
export function getCompProvider(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): CompProvider | null {
  const name = env.COMPS_PROVIDER?.toLowerCase().trim();
  if (!name || name === "off") return null;
  switch (name) {
    case "fixture":
      if (env.VERCEL_ENV === "production") {
        throw new ConfigurationError("COMPS_PROVIDER=fixture is refused in production.");
      }
      return createFixtureProvider();
    case "attom": {
      const apiKey = env.ATTOM_API_KEY?.trim();
      if (!apiKey) throw new ConfigurationError("COMPS_PROVIDER=attom requires ATTOM_API_KEY.");
      return createAttomProvider({
        apiKey,
        baseUrl: env.ATTOM_API_BASE_URL?.trim() || DEFAULT_ATTOM_BASE_URL,
        fetchImpl,
      });
    }
    default:
      throw new ConfigurationError(`Unknown COMPS_PROVIDER: ${name}`);
  }
}
