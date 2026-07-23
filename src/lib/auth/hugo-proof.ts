type AuthenticationMethod =
  | string
  | { method?: string; timestamp?: number };

type AuthIdentity = {
  provider?: string;
  last_sign_in_at?: string;
};

const HUGO_PROVIDER = "custom:hugo";
const CLOCK_SKEW_SECONDS = 60;

/**
 * Prove that Hugo, rather than merely some OAuth provider, authenticated the
 * current session. A linked Hugo identity alone is not enough: users can have
 * multiple identities, while AMR only says "oauth". Supabase updates the
 * identity's last_sign_in_at for the identity used in the current exchange.
 */
export function hasCurrentHugoOAuthProof(
  methods: unknown,
  identities: unknown,
): boolean {
  if (!Array.isArray(methods) || !Array.isArray(identities)) return false;

  const oauthTimestamps = (methods as AuthenticationMethod[])
    .filter((entry) => {
      const method = typeof entry === "string" ? entry : entry.method;
      return (
        method === "oauth" || method === "oauth_provider/authorization_code"
      );
    })
    .map((entry) => (typeof entry === "string" ? undefined : entry.timestamp))
    .filter((timestamp): timestamp is number =>
      Number.isFinite(timestamp),
    );
  if (oauthTimestamps.length === 0) return false;

  const currentOAuthTimestamp = Math.max(...oauthTimestamps);
  return (identities as AuthIdentity[]).some((identity) => {
    if (
      identity.provider !== HUGO_PROVIDER ||
      typeof identity.last_sign_in_at !== "string"
    ) {
      return false;
    }
    const identityTimestamp = Date.parse(identity.last_sign_in_at) / 1000;
    return (
      Number.isFinite(identityTimestamp) &&
      Math.abs(identityTimestamp - currentOAuthTimestamp) <=
        CLOCK_SKEW_SECONDS
    );
  });
}
