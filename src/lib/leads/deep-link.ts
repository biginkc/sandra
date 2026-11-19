/** Shared destination for operator notifications. IDs are property IDs, never contacts or conversations. */
export function buildLeadDeepLink(
  propertyId?: string | null,
  options: { baseUrl?: string; env?: Record<string, string | undefined> } = {},
): string {
  const env = options.env ?? process.env;
  const base = options.baseUrl ?? env.NEXT_PUBLIC_APP_URL ?? env.APP_URL ??
    env.VERCEL_PROJECT_PRODUCTION_URL ?? "https://sandra-sooty.vercel.app";
  const normalized = (/^https?:\/\//.test(base) ? base : `https://${base}`).replace(/\/+$/, "");
  return `${normalized}/leads${propertyId ? `/${encodeURIComponent(propertyId)}` : ""}`;
}
