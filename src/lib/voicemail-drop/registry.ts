import { ConfigurationError } from "@/lib/errors/classes";

import { dropCowboyFromEnv } from "./providers/dropcowboy";
import { MockVoicemailDropProvider } from "./providers/mock";
import type { VoicemailDropProvider } from "./types";

/**
 * Resolve the voicemail drop provider from VOICEMAIL_DROP_PROVIDER. Mirrors
 * src/lib/messaging/registry.ts: unset → null (feature off); named provider
 * with missing credentials → ConfigurationError.
 */
export function getVoicemailDropProvider(
  env: NodeJS.ProcessEnv = process.env,
): VoicemailDropProvider | null {
  const provider = env.VOICEMAIL_DROP_PROVIDER?.toLowerCase().trim();
  if (!provider) return null;
  switch (provider) {
    case "dropcowboy":
      return dropCowboyFromEnv(env);
    case "mock":
      return new MockVoicemailDropProvider();
    default:
      throw new ConfigurationError(`Unknown VOICEMAIL_DROP_PROVIDER: ${provider}`);
  }
}

export function isVoicemailDropEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VOICEMAIL_DROP_PROVIDER?.trim());
}
