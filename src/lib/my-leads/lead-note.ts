import "server-only";

import { assertPropertyDncUnlocked } from "@/lib/dnc/property-lock";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

/**
 * The idempotent twin of `createLeadNote` (leads/actions.ts, a legacy file this stack must not
 * change): same session, DNC and org rules, plus `lead_notes.idempotency_key`. A repeated submit
 * with the same key hits the partial unique index (org_id, idempotency_key) and returns the note
 * that already exists, so a double submit writes one row. Callers check
 * `schemaReady('lead_note_idempotency')` first; this function never runs without the column.
 */
export async function createIdempotentLeadNote(
  propertyId: string,
  body: string,
  idempotencyKey: string,
): Promise<Result<{ id: string }>> {
  const trimmed = body.trim();
  if (!trimmed) {
    return { ok: false, error: { code: "EMPTY_BODY", message: "Note body is empty." } };
  }
  if (trimmed.length > 5000) {
    return {
      ok: false,
      error: { code: "BODY_TOO_LONG", message: `Note is ${trimmed.length} characters — cap is 5000.` },
    };
  }
  try {
    const supabase = await createClient();
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in." } };
    }
    const { data: property, error: lookupErr } = await supabase
      .from("properties")
      .select("org_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (lookupErr) {
      return { ok: false, error: { code: "LEAD_FETCH_FAILED", message: lookupErr.message } };
    }
    if (!property) {
      return { ok: false, error: { code: "LEAD_NOT_FOUND", message: "Lead not found." } };
    }
    const { data: inserted, error } = await supabase
      .from("lead_notes")
      .insert({
        org_id: property.org_id,
        property_id: propertyId,
        author_user_id: user.id,
        body: trimmed,
        idempotency_key: idempotencyKey,
      })
      .select("id")
      .single();
    if (error) {
      if (error.code === "23505") {
        const { data: existing } = await supabase
          .from("lead_notes")
          .select("id")
          .eq("org_id", property.org_id)
          .eq("idempotency_key", idempotencyKey)
          .maybeSingle();
        if (existing?.id) return ok({ id: existing.id });
      }
      return { ok: false, error: { code: "NOTE_CREATE_FAILED", message: error.message } };
    }
    return ok({ id: inserted.id });
  } catch (e) {
    reportError(e, { tags: { surface: "create_idempotent_lead_note" }, extra: { propertyId } });
    return errFromUnknown(e, "NOTE_CREATE_FAILED");
  }
}
