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
 *
 * The Twilio path is dynamically imported so that non-twilio deployments
 * (currently 100% of prod — MESSAGING_PROVIDER=dialpad) don't pull
 * `./providers/twilio` and its `node:crypto` dependency into the import
 * graph of every consumer (webhook routes, server actions, send.ts).
 */
export async function getMessagingProvider(): Promise<MessagingProvider | null> {
  const provider = process.env.MESSAGING_PROVIDER?.toLowerCase().trim();
  if (!provider) return null;

  switch (provider) {
    case "dialpad":
      return dialpadFromEnv();
    case "mock":
      return new MockMessagingProvider();
    case "twilio": {
      const { twilioFromEnv } = await import("./providers/twilio");
      return twilioFromEnv();
    }
    default:
      throw new ConfigurationError(
        `Unknown MESSAGING_PROVIDER: ${provider}`,
      );
  }
}
