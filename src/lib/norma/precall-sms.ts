import type { SupabaseClient } from "@supabase/supabase-js";

import { reportError } from "@/lib/errors/report";
import { sendSmsToContact, type SendSmsOutcome } from "@/lib/messaging/send";
import type { Database, Json } from "@/lib/supabase/types";

import { envFlag, type NormaEnv } from "./config";

type Client = SupabaseClient<Database>;

/**
 * The text Sandra sends the seller immediately before Norma's FIRST call.
 * Wording approved verbatim by Jarrad (2026-10-02); do not edit it without a
 * fresh approval. An empty string turns the whole step into a no-op.
 * Placeholders: {first_name} and {address} only. A blank first name drops the
 * name and its comma ("Hi, this is BMH Group."); a blank address skips the text.
 */
export const NORMA_PRECALL_SMS_TEMPLATE =
  "Hi {first_name}, this is BMH Group. Norma from our team will call you in a minute from (816) 705-3501 about {address}. Reply STOP to opt out.";

/** NORMA_PRECALL_SMS_ENABLED: off unless a human turns it on. */
export function readPrecallSmsEnabled(env: NormaEnv = process.env): boolean {
  return envFlag(env.NORMA_PRECALL_SMS_ENABLED);
}

export type PrecallRender = { ok: true; body: string } | { ok: false; reason: "empty_template" | "missing_address" };

/** Fills the two placeholders. Pure; never throws. */
export function renderPrecallSms(
  template: string,
  values: { firstName: string | null | undefined; address: string | null | undefined },
): PrecallRender {
  if (!template.trim()) return { ok: false, reason: "empty_template" };
  const firstName = (values.firstName ?? "").replace(/\s+/g, " ").trim();
  const address = (values.address ?? "").replace(/\s+/g, " ").trim();
  if (template.includes("{address}") && !address) return { ok: false, reason: "missing_address" };
  const named = firstName ? template.split("{first_name}").join(firstName) : template.replace(/\s*\{first_name\}/g, "");
  return { ok: true, body: named.split("{address}").join(address) };
}

/** What was recorded on the request (`precall_sms_status`). `disabled` / `empty_template` record nothing. */
export type PrecallSmsResult =
  | { status: "disabled" }
  | { status: "empty_template" }
  | { status: "skipped"; detail: string }
  | { status: "sent" | "queued" | "refused" | "failed"; detail: string };

export type PrecallRow = { id: string; org_id: string; property_id: string; contact_id: string | null; phone_e164: string };

export type PrecallDeps = {
  enabled?: boolean;
  template?: string;
  /** Test seam; defaults to Sandra's single outbound SMS pipeline. */
  send?: (input: Parameters<typeof sendSmsToContact>[1]) => Promise<SendSmsOutcome>;
  timeoutMs?: number;
};

/** The text must never hold up a dial for long: dispatch is `dispatching` while it runs. */
export const PRECALL_SMS_TIMEOUT_MS = 15_000;

/**
 * One SMS to the number about to be dialled, through the SAME pipeline reps use
 * (`sendSmsToContact`: consent, opt-out, DNC, quiet hours, sender approval).
 * Origin is `automated`, so the stricter final-dispatch suppression applies.
 * NEVER throws and never blocks the call: a refusal or failure is returned (and
 * recorded by the caller) and the call is placed anyway. Only ever called for
 * attempt 1; the retry never texts again.
 */
export async function sendNormaPrecallSms(client: Client, row: PrecallRow, deps: PrecallDeps = {}): Promise<PrecallSmsResult> {
  const enabled = deps.enabled ?? readPrecallSmsEnabled();
  if (!enabled) return { status: "disabled" };
  const template = deps.template ?? NORMA_PRECALL_SMS_TEMPLATE;
  if (!template.trim()) return { status: "empty_template" };
  if (!row.contact_id) return { status: "skipped", detail: "no_contact" };

  try {
    const [{ data: contact, error: contactError }, { data: property, error: propertyError }] = await Promise.all([
      client.from("contacts").select("first_name").eq("id", row.contact_id).maybeSingle(),
      client.from("properties").select("address").eq("id", row.property_id).eq("org_id", row.org_id).maybeSingle(),
    ]);
    if (contactError || propertyError) return { status: "failed", detail: "lead_facts_unreadable" };
    const rendered = renderPrecallSms(template, { firstName: contact?.first_name, address: property?.address });
    if (!rendered.ok) return { status: "skipped", detail: rendered.reason };

    const send = deps.send ?? ((input) => sendSmsToContact(client, input));
    const timeoutMs = deps.timeoutMs ?? PRECALL_SMS_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      send({
        origin: "automated",
        contactId: row.contact_id,
        propertyId: row.property_id,
        // The number Norma is about to call, never another saved phone.
        to: row.phone_e164,
        body: rendered.body,
        requireStickyFrom: true,
        allowDefaultFromWhenNoSticky: true,
        metadata: { generated_by: "norma_precall", request_id: row.id } as Json,
      }),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    if (outcome === "timeout") return { status: "failed", detail: "timeout" };
    if (outcome.status === "sent" || outcome.status === "queued") return { status: outcome.status, detail: outcome.status };
    if (outcome.status === "db_error") return { status: "failed", detail: "db_error" };
    // Transient consent/suppression read failure: refused (no text sent), call still placed.
    if (outcome.status === "blocked_fresh_state_unavailable") return { status: "refused", detail: "consent_unavailable" };
    return { status: "refused", detail: outcome.status };
  } catch (error) {
    reportError(error, { tags: { surface: "norma_precall_sms" }, extra: { requestId: row.id } });
    return { status: "failed", detail: "exception" };
  }
}
