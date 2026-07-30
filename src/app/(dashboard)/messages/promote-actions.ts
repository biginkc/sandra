"use server";

import { revalidatePath } from "next/cache";

import { reportError } from "@/lib/errors/report";
import { qualifyProperty } from "@/lib/leads/qualify";
import { createClient } from "@/lib/supabase/server";

export type PromoteProspectToLeadResult =
  | { ok: true; alreadyQualified: boolean }
  | { ok: false; error: string };

export async function promoteProspectToLeadAction(
  propertyId: string,
): Promise<PromoteProspectToLeadResult> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError) {
      return { ok: false, error: authError.message };
    }
    if (!user) {
      return { ok: false, error: "You must be signed in to promote a lead." };
    }

    const { data: property, error: propertyError } = await supabase
      .from("properties")
      .select("id, status")
      .eq("id", propertyId)
      .is("deleted_at", null)
      .maybeSingle();

    if (propertyError) {
      return { ok: false, error: propertyError.message };
    }
    if (!property) {
      return { ok: false, error: "Property not found." };
    }
    if (property.status !== "prospect") {
      return {
        ok: false,
        error: "Only prospects can be promoted from Messages.",
      };
    }

    const outcome = await qualifyProperty(supabase, propertyId, user.id);
    switch (outcome.status) {
      case "qualified":
        revalidateMessagesLeadViews(propertyId);
        return { ok: true, alreadyQualified: false };
      case "already_qualified":
        revalidateMessagesLeadViews(propertyId);
        return { ok: true, alreadyQualified: true };
      case "not_found":
        return { ok: false, error: "Property not found." };
      case "failed":
        return { ok: false, error: outcome.message };
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "messages_promote_prospect_to_lead" },
      extra: { propertyId },
    });
    return { ok: false, error: "Could not promote this prospect." };
  }
}

function revalidateMessagesLeadViews(propertyId: string) {
  revalidatePath("/messages");
  revalidatePath("/properties");
  revalidatePath("/leads");
  revalidatePath(`/leads/${propertyId}`);
}
