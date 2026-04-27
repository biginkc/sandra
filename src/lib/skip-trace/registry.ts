import { ConfigurationError } from "@/lib/errors/classes";

import { MockSkipTraceProvider } from "./providers/mock";
import { tracerfyFromEnv } from "./providers/tracerfy";
import type { SkipTraceProvider } from "./types";

/**
 * Resolve the configured skip-trace provider. Returns null when the
 * provider env var is unset (deliberate "feature off" — the UI stays
 * disabled). Throws ConfigurationError when the provider is named but
 * its credentials are missing — that's a setup mistake, not a runtime
 * toggle.
 *
 * `mock` is reserved for the integration test suite via
 * `SKIP_TRACE_PROVIDER=mock` in `.env.test.local`.
 */
export function getSkipTraceProvider(): SkipTraceProvider | null {
  const provider = process.env.SKIP_TRACE_PROVIDER?.toLowerCase().trim();
  if (!provider) return null;

  switch (provider) {
    case "mock":
      return new MockSkipTraceProvider();
    case "tracerfy":
      return tracerfyFromEnv();
    default:
      throw new ConfigurationError(
        `Unknown SKIP_TRACE_PROVIDER: ${provider}`,
      );
  }
}
