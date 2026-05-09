/**
 * Shared utilities for the SMS prod canaries.
 *
 * - Env bootstrap (reads .env.local + process.env, prefers process.env
 *   so GitHub Actions secrets win over local files).
 * - Supabase client (service-role; refuses to run against the test
 *   project as a safety net for canaries that mutate prod data).
 * - JWT signer for forging Dialpad-style webhook bodies (HS256, body
 *   IS the JWT — header.payload.signature).
 * - POST helper that targets the prod inbound webhook.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Database } from "../src/lib/supabase/types";

// ----------- env -------------------------------------------------------------

function loadLocalEnv(file: string): Record<string, string> {
  const p = path.resolve(process.cwd(), file);
  if (!fs.existsSync(p)) return {};
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

export const env = { ...loadLocalEnv(".env.local"), ...process.env } as Record<
  string,
  string | undefined
>;

// ----------- supabase --------------------------------------------------------

const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";
const TEST_PROJECT_REF = "ncsngxlcyxylaeskiteu";

export function prodSupabase(): SupabaseClient<Database> {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. " +
        "Canaries need prod creds; populate .env.local or GitHub secrets.",
    );
  }
  if (url.includes(TEST_PROJECT_REF)) {
    throw new Error(
      "URL points at the TEST project — canaries are prod-only by design. Aborting.",
    );
  }
  if (!url.includes(PROD_PROJECT_REF)) {
    // Fail-loud if pointed at neither known project; keeps a stray URL
    // from quietly seeding a bystander database.
    throw new Error(
      `URL ${url} doesn't match the prod project ref. Refusing to run.`,
    );
  }
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function resolveActiveAiResponderOrgId(
  supabase: SupabaseClient<Database>,
): Promise<string> {
  const { data, error } = await supabase
    .from("ai_responder_configs")
    .select("org_id")
    .eq("active", true)
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Could not resolve active AI responder org: ${error.message}`);
  }
  if (!data?.org_id) {
    throw new Error("No active AI responder config found in production.");
  }
  return data.org_id;
}

// ----------- prod URL --------------------------------------------------------

/** Stable prod alias. Override with PROD_BASE_URL when a custom domain lands. */
export const PROD_BASE_URL =
  env.PROD_BASE_URL ?? "https://sandra-sooty.vercel.app";

// ----------- JWT signer ------------------------------------------------------

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export type DialpadInboundEvent = {
  id: string;
  from_number: string;
  to_number: string;
  text: string;
  timestamp?: string;
};

/**
 * Build a Dialpad-shape webhook body: an HS256 JWT signed with the
 * shared `DIALPAD_WEBHOOK_SECRET`. The webhook handler verifies the
 * JWT signature and parses the payload as the event body. (The
 * production secret comes from the env, NOT hardcoded.)
 */
export function buildDialpadWebhookBody(event: DialpadInboundEvent): string {
  const secret = env.DIALPAD_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "DIALPAD_WEBHOOK_SECRET missing — canary needs the same secret " +
        "the Dialpad provider uses to verify inbound webhook deliveries.",
    );
  }
  const header = base64url(
    Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }), "utf8"),
  );
  const payload = base64url(Buffer.from(JSON.stringify(event), "utf8"));
  const sig = createHmac("sha256", secret)
    .update(`${header}.${payload}`)
    .digest();
  return `${header}.${payload}.${base64url(sig)}`;
}

/** POST a forged inbound to the prod webhook. Returns the response status. */
export async function fireInboundWebhook(
  event: DialpadInboundEvent,
): Promise<number> {
  const body = buildDialpadWebhookBody(event);
  const res = await fetch(`${PROD_BASE_URL}/api/webhooks/dialpad/sms`, {
    method: "POST",
    headers: { "content-type": "application/jwt" },
    body,
  });
  return res.status;
}

// ----------- polling ---------------------------------------------------------

/**
 * Poll `fn` every `intervalMs` until it returns a non-null value or
 * `timeoutMs` elapses. Returns the value or throws on timeout.
 */
export async function pollUntil<T>(
  fn: () => Promise<T | null>,
  opts: { intervalMs?: number; timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const intervalMs = opts.intervalMs ?? 2_000;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const label = opts.label ?? "condition";
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}
