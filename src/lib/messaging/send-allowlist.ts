import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import type { Database } from "@/lib/supabase/types";

/**
 * Final send boundary isolation for production test work (STRESS-TEST-DESIGN §5.4).
 *
 * A send whose lead (properties.test_run_id) or work item carries a `test_run_id` may go ONLY
 * to a destination on TEST_DEST_ALLOWLIST (the business's own numbers, set in the environment
 * at run time; numbers are never committed). Anything else is refused before the provider and
 * recorded (`refused_non_owned`). A send with no test tag is not affected.
 *
 * TEST_DEST_ALLOWLIST: comma / semicolon / newline separated phone numbers (any common format). The test harness fills it
 * at run time (e.g. from 1Password via the service account). Entries that do not normalize to
 * a US E.164 number are ignored (they can never match), never widened.
 */
export const REFUSED_NON_OWNED = "refused_non_owned" as const;

/** Strict US E.164: strips spaces, dashes, dots and parentheses; +1 default; letters / short codes rejected. */
export function normalizeDestination(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!t || /[a-z]/i.test(t)) return null;
  if (/[^0-9+()\-.\s]/.test(t)) return null;
  const plus = t.startsWith("+");
  if (t.slice(1).includes("+")) return null;
  const digits = t.replace(/\D/g, "");
  if (plus) return digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function parseTestDestAllowlist(raw: string | null | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  // Separators: comma, semicolon or newline (spaces stay inside a formatted number).
  for (const part of String(raw ?? "").split(/[,;\n]+/)) {
    const n = normalizeDestination(part);
    if (n) out.add(n);
  }
  return out;
}

export type SendAllowDecision =
  | { allowed: true; tested: boolean }
  | { allowed: false; reason: typeof REFUSED_NON_OWNED };

/** Pure decision. No test tag = allowed exactly as today. */
export function decideSendAllowed(input: {
  testRunId: string | null | undefined;
  destination: string | null | undefined;
  allowlist: ReadonlySet<string>;
}): SendAllowDecision {
  const tag = typeof input.testRunId === "string" ? input.testRunId.trim() : "";
  if (!tag) return { allowed: true, tested: false };
  const dest = normalizeDestination(input.destination);
  if (dest && input.allowlist.has(dest)) return { allowed: true, tested: true };
  return { allowed: false, reason: REFUSED_NON_OWNED };
}

type Loose = {
  from: (t: string) => {
    select: (c: string) => { eq: (k: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> } };
    insert: (row: Record<string, unknown>) => PromiseLike<{ error: { message: string } | null }>;
  };
};

/**
 * The lead's test tag. A database that does not have the column yet (deployed ahead of the
 * migration) has no tagged leads: untagged. Any other read failure is reported as an error.
 */
export async function loadLeadTestRunId(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<{ ok: true; testRunId: string | null } | { ok: false; error: string }> {
  try {
    const { data, error } = await (supabase as unknown as Loose)
      .from("properties").select("test_run_id").eq("id", propertyId).maybeSingle();
    if (error) {
      if (error.code === "42703" || /test_run_id/.test(error.message) && /does not exist|Could not find/i.test(error.message)) {
        return { ok: true, testRunId: null };
      }
      return { ok: false, error: error.message };
    }
    const v = (data as { test_run_id?: unknown } | null)?.test_run_id;
    return { ok: true, testRunId: typeof v === "string" && v.trim() ? v : null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The boundary check, called immediately before the provider submission. Returns true when the
 * send may proceed. A refusal is recorded (test_send_refusals; last 4 digits only) and reported.
 */
export async function assertSendAllowed(
  supabase: SupabaseClient<Database>,
  input: {
    orgId: string | null;
    propertyId: string;
    destination: string;
    origin: string;
    /** The work item's own tag (e.g. a routing v2 outbox row); the lead's tag is always read too. */
    testRunId?: string | null;
    messageId?: string | null;
    env?: Record<string, string | undefined>;
  },
): Promise<boolean> {
  const env = input.env ?? process.env;
  // A test run is active in this environment only while TEST_DEST_ALLOWLIST is configured.
  const testRunActive = String(env.TEST_DEST_ALLOWLIST ?? "").trim() !== "";
  const lead = await loadLeadTestRunId(supabase, input.propertyId);
  if (!lead.ok) {
    reportError(new Error(`send allowlist taint lookup failed: ${lead.error}`), {
      tags: { surface: "send_allowlist" }, extra: { propertyId: input.propertyId },
    });
    // Fail closed while a test run is active (the lead might be tagged); with no test run in
    // this environment a lookup hiccup never changes a production send.
    if (testRunActive || input.testRunId?.trim()) return false;
  }
  const testRunId = input.testRunId?.trim() || (lead.ok ? lead.testRunId : null);
  const decision = decideSendAllowed({
    testRunId,
    destination: input.destination,
    allowlist: parseTestDestAllowlist(env.TEST_DEST_ALLOWLIST),
  });
  if (decision.allowed) return true;
  const digits = (input.destination ?? "").replace(/\D/g, "");
  const last4 = digits.slice(-4) || null;
  try {
    const { error } = await (supabase as unknown as Loose).from("test_send_refusals").insert({
      org_id: input.orgId, property_id: input.propertyId, test_run_id: testRunId,
      destination_last4: last4, origin: input.origin, reason: decision.reason, message_id: input.messageId ?? null,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    reportError(e, { tags: { surface: "send_allowlist_record" }, extra: { propertyId: input.propertyId } });
  }
  reportError(new Error(`${REFUSED_NON_OWNED}: test-tagged send to a non-allowlisted number`), {
    tags: { surface: "send_allowlist", reason: REFUSED_NON_OWNED },
    extra: { propertyId: input.propertyId, testRunId, destinationLast4: last4, origin: input.origin },
  });
  return false;
}
