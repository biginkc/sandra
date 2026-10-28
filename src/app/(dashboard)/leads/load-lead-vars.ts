"use server";

import { reportError } from "@/lib/errors/report";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { resolveEffectiveHomeownerContactId } from "@/lib/leads/effective-homeowner";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import { createClient } from "@/lib/supabase/server";
import type { TemplateVars } from "@/lib/templates/render";

/**
 * `loadLeadVars` from `leads/actions.ts` (frozen by CI) plus the effective
 * homeowner fallback, so `{{first_name}}` resolves on leads whose people are
 * linked only through `property_contacts`.
 */
export async function loadLeadVars(
  propertyId: string,
): Promise<Result<TemplateVars>> {
  try {
    const supabase = await createClient();

    const { data: property, error: propErr } = await supabase
      .from("properties")
      .select("homeowner_contact_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (propErr) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: propErr.message },
      };
    }
    if (!property) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }

    const vars = await loadTemplateVars(supabase, {
      propertyId,
      contactId: await resolveEffectiveHomeownerContactId(supabase, {
        propertyId,
        homeownerContactId: property.homeowner_contact_id,
      }),
    });

    return ok(vars);
  } catch (e) {
    reportError(e, {
      tags: { surface: "load_lead_vars" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "LOAD_LEAD_VARS_FAILED");
  }
}
