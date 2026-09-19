import "server-only";

import { AuthorizationError, ConfigurationError } from "@/lib/errors/classes";

/**
 * Sendillo's bearer key is application scoped, while Sandra data is
 * organization scoped.  Keep this check in one server-only module so every
 * rep-SMS read and send path applies the same fence before using the key.
 *
 * The optional provider id lets tests and callers using the mock provider
 * keep their existing setup.  An explicit Sendillo configuration still
 * wins, even if an untrusted context claims another provider.
 */
export const SENDILLO_PROVIDER_ID = "sendillo" as const;

export const SENDILLO_ORG_SCOPE_MISSING_MESSAGE =
  "Sendillo texting organization scope is not configured. Set SENDILLO_ORG_ID before assigning numbers.";
export const SENDILLO_ORG_SCOPE_DENIED_MESSAGE =
  "Sendillo texting is not available for this organization.";

function configuredProvider(): string | null {
  return process.env.MESSAGING_PROVIDER?.trim().toLowerCase() || null;
}

function isSendilloPath(providerId?: string | null): boolean {
  const configured = configuredProvider();
  const requested = providerId?.trim().toLowerCase() || null;

  // A configured Sendillo adapter must be fenced even if a stale/forged
  // context reports another provider.  Conversely, explicit mock use keeps
  // deterministic tests independent of production-only scope settings.
  if (configured === SENDILLO_PROVIDER_ID) return true;
  if (requested === SENDILLO_PROVIDER_ID) return true;
  return !configured && Boolean(process.env.SENDILLO_API_KEY);
}

/**
 * Assert that an organization is the sole tenant authorized to use the
 * configured Sendillo connection.  Missing configuration and mismatches are
 * both hard failures; callers must perform this before provider catalog reads
 * or a provider POST.
 */
export function assertSendilloOrganizationScope(
  orgId: string | null | undefined,
  providerId?: string | null,
): void {
  if (!isSendilloPath(providerId)) return;

  const configuredOrgId = process.env.SENDILLO_ORG_ID?.trim() || null;
  if (!configuredOrgId) {
    throw new ConfigurationError(SENDILLO_ORG_SCOPE_MISSING_MESSAGE);
  }
  if (!orgId?.trim() || configuredOrgId !== orgId.trim()) {
    throw new AuthorizationError(SENDILLO_ORG_SCOPE_DENIED_MESSAGE);
  }
}
