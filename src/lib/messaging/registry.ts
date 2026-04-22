import { ConfigurationError } from "@/lib/errors/classes";

import { dialpadFromEnv } from "./providers/dialpad";
import { MockMessagingProvider } from "./providers/mock";
import type { MessagingProvider } from "./types";

/**
 * Resolve the configured messaging provider. Mirrors
 * `src/lib/enrichment/registry.ts` — returns null when the env var is
 * unset (feature off), throws ConfigurationError when a provider is
 * named but its credentials are missing.
 *
 * `mock` is reserved for the integration test suite and for exercising
 * the UI without real Dialpad credentials. Production never sets
 * MESSAGING_PROVIDER=mock.
 */
export function getMessagingProvider(): MessagingProvider | null {
  const provider = process.env.MESSAGING_PROVIDER?.toLowerCase().trim();
  if (!provider) return null;

  switch (provider) {
    case "dialpad":
      return dialpadFromEnv();
    case "mock":
      return new MockMessagingProvider();
    // case "twilio": return twilioFromEnv();   — add when registered
    default:
      throw new ConfigurationError(
        `Unknown MESSAGING_PROVIDER: ${provider}`,
      );
  }
}
