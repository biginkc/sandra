import { ConfigurationError } from "@/lib/errors/classes";

import { smartyStreetsFromEnv } from "./providers/smartystreets";
import type { AddressVerifier } from "./types";

/**
 * Resolve the configured address verifier. Returns null when the provider
 * env var is unset (deliberate "feature off" state, not an error). Throws
 * ConfigurationError when the provider is set but its credentials are
 * missing — that's a setup mistake, not a runtime feature toggle.
 */
export function getAddressVerifier(): AddressVerifier | null {
  const provider = process.env.ADDRESS_VERIFIER_PROVIDER?.toLowerCase().trim();
  if (!provider) return null;

  switch (provider) {
    case "smartystreets":
      return smartyStreetsFromEnv();
    // case "lob":   return lobFromEnv();   — add when needed
    // case "melissa": ...
    default:
      throw new ConfigurationError(
        `Unknown ADDRESS_VERIFIER_PROVIDER: ${provider}`,
      );
  }
}
