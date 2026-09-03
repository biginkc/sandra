"use server";

import { redirect } from "next/navigation";

import { createLead } from "@/lib/leads/create";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { LEAD_PHONE_UNVERIFIED_NOTICE } from "@/lib/leads/notices";
import type { LeadSource } from "@/lib/leads/sources";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export type NewLeadFormResult = Result<{
  propertyId: string;
  wasDuplicate: boolean;
  /** True when the phone was saved but its line type could not be verified. */
  phoneUnverified: boolean;
}>;

/**
 * Server action for the manual `/leads/new` form. Wraps `createLead`
 * with the auth + redirect logic the form needs. Used by VAs to enter
 * a lead post-call (off-Enzo) or by anyone who picked up a lead through
 * a non-automated channel (referral conversation, walk-in, etc.).
 *
 * Source value is supplied by the user via the dropdown — every entry
 * is attributed cleanly. There is no "manual" catch-all; if the channel
 * isn't in the canonical list, the form blocks the submit.
 */
export async function createLeadFromForm(
  input: {
    org_id: string;
    source: string;
    address: string;
    city: string;
    state: string;
    zip: string;
    market: string;
    first_name: string;
    last_name: string;
    phone_1: string;
    email: string;
    assigned_user_id?: string | null;
    motivation_level?: "hot" | "warm" | "cold" | null;
  },
): Promise<NewLeadFormResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "AUTH", message: "Sign in required." },
      };
    }

    const nowIso = new Date().toISOString();
    const admin = createAdminClient();
    const requestedOrgId = input.org_id.trim();
    if (!requestedOrgId) {
      return {
        ok: false,
        error: {
          code: "WORKSPACE_REQUIRED",
          message: "Choose the workspace for this lead.",
        },
      };
    }
    const { data: activeMembership, error: activeMembershipError } = await admin
      .from("memberships")
      .select("org_id")
      .eq("user_id", user.id)
      .eq("org_id", requestedOrgId)
      .eq("access_status", "active")
      .is("deletion_prepared_at", null)
      .or(`access_expires_at.is.null,access_expires_at.gt.${nowIso}`)
      .maybeSingle();
    if (activeMembershipError) {
      return {
        ok: false,
        error: {
          code: "WORKSPACE_VALIDATION_FAILED",
          message: "We couldn't verify your workspace. Try again.",
        },
      };
    }
    const orgId = activeMembership?.org_id;
    if (!orgId) {
      return {
        ok: false,
        error: {
          code: "NO_ACTIVE_WORKSPACE",
          message: "You need an active workspace before creating a lead.",
        },
      };
    }

    const assignedUserId =
      input.assigned_user_id === undefined
        ? user.id
        : input.assigned_user_id?.trim() || null;
    if (assignedUserId) {
      const { data: sharedMembership, error: assigneeError } = await admin
        .from("memberships")
        .select("user_id")
        .eq("user_id", assignedUserId)
        .eq("org_id", orgId)
        .eq("access_status", "active")
        .is("deletion_prepared_at", null)
        .or(`access_expires_at.is.null,access_expires_at.gt.${nowIso}`)
        .limit(1)
        .maybeSingle();
      if (assigneeError || !sharedMembership) {
        return {
          ok: false,
          error: {
            code: "INVALID_ASSIGNEE",
            message: "Choose a teammate who belongs to your workspace.",
          },
        };
      }
    }

    const result = await createLead(supabase, {
      orgId,
      source: input.source as LeadSource,
      property: {
        address: input.address,
        city: input.city || null,
        state: input.state,
        zip: input.zip || null,
        market: input.market || null,
      },
      contact: input.first_name || input.last_name || input.phone_1 || input.email
        ? {
            first_name: input.first_name || null,
            last_name: input.last_name || null,
            phone_1: input.phone_1 || null,
            email: input.email || null,
          }
        : undefined,
      createdBy: user.id,
      assignedUserId,
      motivationLevel: input.motivation_level ?? null,
    });

    if (!result.ok) {
      return {
        ok: false,
        error: {
          code: result.error.code,
          message: result.error.message,
          details: result.error.field
            ? { field: result.error.field }
            : undefined,
        },
      };
    }

    return ok({
      propertyId: result.data.propertyId,
      wasDuplicate: result.data.wasDuplicate,
      phoneUnverified: result.data.phoneUnverified,
    });
  } catch (e) {
    reportError(e, { tags: { surface: "create_lead_from_form" } });
    return errFromUnknown(e, "CREATE_LEAD_FAILED");
  }
}

/**
 * Wrapper used by the form's `<form action={...}>` so React/Next.js
 * can serialize the call. Reads form fields out of the FormData
 * object then delegates to `createLeadFromForm`. On success, redirects
 * to the new lead's detail page so the operator immediately sees what
 * they entered.
 */
export async function submitNewLead(formData: FormData): Promise<void> {
  const input = {
    org_id: String(formData.get("org_id") ?? "").trim(),
    source: String(formData.get("source") ?? ""),
    address: String(formData.get("address") ?? "").trim(),
    city: String(formData.get("city") ?? "").trim(),
    state: String(formData.get("state") ?? "").trim(),
    zip: String(formData.get("zip") ?? "").trim(),
    market: String(formData.get("market") ?? "").trim(),
    first_name: String(formData.get("first_name") ?? "").trim(),
    last_name: String(formData.get("last_name") ?? "").trim(),
    phone_1: String(formData.get("phone_1") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
  };
  const result = await createLeadFromForm(input);
  if (!result.ok) {
    // Surface the error via a query-string param the form reads.
    redirect(
      `/leads/new?error=${encodeURIComponent(result.error.message)}${result.error.details && typeof result.error.details === "object" && "field" in result.error.details ? `&field=${encodeURIComponent(String(result.error.details.field))}` : ""}`,
    );
  }
  if (result.data.wasDuplicate) {
    redirect(
      `/leads/new?error=${encodeURIComponent("A lead already exists at this address. Open the existing record instead.")}`,
    );
  }
  if (result.data.phoneUnverified) {
    redirect(
      `/leads/${result.data.propertyId}?notice=${LEAD_PHONE_UNVERIFIED_NOTICE}`,
    );
  }
  redirect(`/leads/${result.data.propertyId}`);
}
