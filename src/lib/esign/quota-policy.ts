import "server-only";

type AccountQuotaResponse = {
  account_id?: unknown;
  accountId?: unknown;
  quotas?: {
    api_signature_requests_left?: unknown;
    apiSignatureRequestsLeft?: unknown;
    documents_left?: unknown;
    documentsLeft?: unknown;
  };
};

/** Shared allowances require explicit, time-bounded billing verification per account. */
export function remainingSignatureRequests(
  account: AccountQuotaResponse | undefined,
  expectedAccountId: string,
  policyJson: string | undefined,
  now = Date.now(),
): number | null {
  if (!expectedAccountId || !account ||
      (account.account_id ?? account.accountId) !== expectedAccountId) return null;

  let allowance: number | undefined;
  let shared = false;
  if (policyJson?.trim()) {
    try {
      const policies: unknown = JSON.parse(policyJson);
      if (!policies || typeof policies !== "object" || Array.isArray(policies)) return null;
      const policy = Object.hasOwn(policies, expectedAccountId)
        ? (policies as Record<string, unknown>)[expectedAccountId]
        : undefined;
      if (policy !== undefined) {
        if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
        const p = policy as Record<string, unknown>;
        const verifiedAt = typeof p.verifiedAt === "string" ? Date.parse(p.verifiedAt) : NaN;
        const validUntil = typeof p.validUntil === "string" ? Date.parse(p.validUntil) : NaN;
        if (p.basis !== "shared_signature_requests" || typeof p.plan !== "string" || !p.plan.trim() ||
            typeof p.allowance !== "number" || !Number.isSafeInteger(p.allowance) || p.allowance <= 0 ||
            !Number.isFinite(verifiedAt) || !Number.isFinite(validUntil) ||
            verifiedAt > now || validUntil <= now || validUntil <= verifiedAt ||
            validUntil - verifiedAt > 32 * 24 * 60 * 60 * 1000) return null;
        shared = true;
        allowance = p.allowance;
      }
    } catch {
      return null;
    }
  }

  const quotas = account.quotas;
  const remaining = shared
    ? quotas?.documents_left ?? quotas?.documentsLeft
    : quotas?.api_signature_requests_left ?? quotas?.apiSignatureRequestsLeft;
  return typeof remaining === "number" && Number.isSafeInteger(remaining) && remaining >= 0 &&
    (allowance === undefined || remaining <= allowance) ? remaining : null;
}
