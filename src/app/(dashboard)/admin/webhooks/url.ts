/**
 * URL helper for webhook consumer secrets.
 *
 * Returns the full URL an integrator should hit for this consumer.
 * Reads `NEXT_PUBLIC_SITE_URL` if set; otherwise hardcodes the prod
 * alias (`https://sandra-sooty.vercel.app`) per the
 * `reference_prod_url` memory — never give Jarrad a deployment-specific
 * Vercel URL.
 *
 * Lead consumers point at the lead-intake route (creates a property +
 * homeowner contact). Provider consumers point at the skip-trace
 * callback route (matches results back to an existing skip-trace job).
 *
 * The plaintext secret goes in the URL path. We only return the URL
 * once — at consumer creation or rotation time — because the plaintext
 * isn't stored anywhere; only its SHA-256 hash lives in the DB.
 */

export type WebhookConsumerType = "lead" | "provider";

export const PROD_BASE_URL = "https://sandra-sooty.vercel.app";

export function webhookBaseUrl(): string {
  // Trim a trailing slash if present so we can always template `${base}/api/...`.
  const fromEnv = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const base = fromEnv && fromEnv.length > 0 ? fromEnv : PROD_BASE_URL;
  return base.replace(/\/$/, "");
}

export function webhookPathForType(type: WebhookConsumerType): string {
  // Lead intake: `/api/webhooks/leads/<secret>` — owned by
  // `src/app/api/webhooks/leads/[secret]/route.ts`.
  // Provider callbacks: `/api/webhooks/skip-trace/<secret>` — the
  // generalized provider route that replaces the legacy
  // `/api/webhooks/tracerfy/<secret>`. Owned by the parallel
  // unify-Tracerfy PR.
  return type === "lead" ? "/api/webhooks/leads" : "/api/webhooks/skip-trace";
}

export function buildWebhookUrl(
  type: WebhookConsumerType,
  plaintextSecret: string,
): string {
  return `${webhookBaseUrl()}${webhookPathForType(type)}/${plaintextSecret}`;
}
