import type { SupabaseClient } from "@supabase/supabase-js";

import {
  err,
  errFromUnknown,
  ok,
  type AppErrorShape,
  type Result,
} from "@/lib/errors/result";
import type { Database } from "@/lib/supabase/types";

/**
 * Triage helpers for the cockpit's "Unknown sender" bucket. Pure
 * functions parameterised by supabase so they're equally usable from
 * server actions and from the integration test suite.
 *
 * Three operations:
 *  1. matchUnknownSender   — attach unmatched messages to an existing contact
 *  2. createContactFromUnknown — create a new contact + property and attach
 *  3. dismissUnknownSender / restoreDismissedSender — soft-delete toggle
 *
 * All three operate on every message from the same `from_address` (not
 * just one row), so once a sender is triaged they fall out of the
 * Unknown bucket as a unit.
 */

export type MatchUnknownSenderInput = {
  supabase: SupabaseClient<Database>;
  fromAddress: string;
  contactId: string;
};

export async function matchUnknownSender(
  input: MatchUnknownSenderInput,
): Promise<Result<{ updated: number }>> {
  const { supabase, fromAddress, contactId } = input;
  try {
    const { data: contact, error: fetchErr } = await supabase
      .from("contacts")
      .select("phone_1, phone_2, phone_3")
      .eq("id", contactId)
      .maybeSingle();
    if (fetchErr) {
      return err({ code: "CONTACT_FETCH_FAILED", message: fetchErr.message });
    }
    if (!contact) {
      return err({ code: "CONTACT_NOT_FOUND", message: "Contact does not exist." });
    }

    // If from_address is already in any phone slot, no contact update needed.
    const alreadyHas =
      contact.phone_1 === fromAddress ||
      contact.phone_2 === fromAddress ||
      contact.phone_3 === fromAddress;

    if (!alreadyHas) {
      const updates: Partial<{ phone_2: string; phone_3: string }> = {};
      if (!contact.phone_2) updates.phone_2 = fromAddress;
      else if (!contact.phone_3) updates.phone_3 = fromAddress;
      else {
        return err({
          code: "PHONE_SLOTS_FULL",
          message:
            "Contact already has phone_1, phone_2, and phone_3 set. Free a slot before matching.",
        });
      }

      const { error: updateErr } = await supabase
        .from("contacts")
        .update(updates)
        .eq("id", contactId);
      if (updateErr) {
        return err({
          code: "CONTACT_UPDATE_FAILED",
          message: updateErr.message,
        });
      }
    }

    // Backfill: every unmatched message from this sender gets the contact.
    const { data: updated, error: msgErr } = await supabase
      .from("messages")
      .update({ contact_id: contactId })
      .eq("from_address", fromAddress)
      .is("contact_id", null)
      .select("id");
    if (msgErr) {
      return err({ code: "MESSAGE_UPDATE_FAILED", message: msgErr.message });
    }

    return ok({ updated: updated?.length ?? 0 });
  } catch (e) {
    return errFromUnknown(e, "MATCH_UNKNOWN_FAILED");
  }
}

/**
 * Role of the new contact on the property. NOT the same as
 * `contacts.contact_type` (which is `person` vs `entity`). The role
 * decides which detail-table row gets created and which property FK
 * gets set.
 */
export type ContactRole = "homeowner" | "agent";

export type CreateContactFromUnknownInput = {
  supabase: SupabaseClient<Database>;
  fromAddress: string;
  role: ContactRole;
  contact: {
    firstName?: string | null;
    lastName?: string | null;
    entityName?: string | null;
  };
  property: {
    address: string;
    city?: string | null;
    state: string;
    zip?: string | null;
  };
};

export async function createContactFromUnknown(
  input: CreateContactFromUnknownInput,
): Promise<Result<{ contactId: string; propertyId: string }>> {
  const { supabase, fromAddress, role, contact, property } = input;
  try {
    const { data: c, error: cErr } = await supabase
      .from("contacts")
      .insert({
        first_name: contact.firstName ?? null,
        last_name: contact.lastName ?? null,
        entity_name: contact.entityName ?? null,
        phone_1: fromAddress,
      })
      .select("id")
      .single();
    if (cErr || !c) {
      return err({
        code: "CONTACT_INSERT_FAILED",
        message: cErr?.message ?? "no contact id returned",
      });
    }

    // Detail row matching the role.
    const detailErr = await insertRoleDetail(supabase, c.id, role);
    if (detailErr) {
      await supabase.from("contacts").delete().eq("id", c.id);
      return err(detailErr);
    }

    const { data: p, error: pErr } = await supabase
      .from("properties")
      .insert({
        address: property.address,
        city: property.city ?? null,
        state: property.state,
        zip: property.zip ?? null,
        homeowner_contact_id: role === "homeowner" ? c.id : null,
        agent_contact_id: role === "agent" ? c.id : null,
        status: "new_lead",
      })
      .select("id")
      .single();
    if (pErr || !p) {
      // Clean up the orphaned contact + detail row so a retry isn't
      // blocked by the unique phone_1 partial index.
      await deleteRoleDetail(supabase, c.id, role);
      await supabase.from("contacts").delete().eq("id", c.id);
      return err({
        code: "PROPERTY_INSERT_FAILED",
        message: pErr?.message ?? "no property id returned",
      });
    }

    const { error: msgErr } = await supabase
      .from("messages")
      .update({ contact_id: c.id, property_id: p.id })
      .eq("from_address", fromAddress)
      .is("contact_id", null);
    if (msgErr) {
      return err({
        code: "MESSAGE_BACKFILL_FAILED",
        message: msgErr.message,
      });
    }

    return ok({ contactId: c.id, propertyId: p.id });
  } catch (e) {
    return errFromUnknown(e, "CREATE_FROM_UNKNOWN_FAILED");
  }
}

export type MergeUnknownSenderToPropertyInput = {
  supabase: SupabaseClient<Database>;
  fromAddress: string;
  propertyId: string;
  role: ContactRole;
  contact: {
    firstName?: string | null;
    lastName?: string | null;
    entityName?: string | null;
  };
};

/**
 * Merge an unknown sender into an existing property. Creates a new
 * contact (with the from_address as phone_1) and a matching detail row
 * (`homeowner_details` or `agent_details`), sets the appropriate FK on
 * the property, then attaches every message from that from_address.
 *
 * Errors PROPERTY_ROLE_TAKEN if the property already has a contact in
 * the requested role — the VA needs to clear that slot first or pick a
 * different role.
 */
export async function mergeUnknownSenderToProperty(
  input: MergeUnknownSenderToPropertyInput,
): Promise<Result<{ contactId: string }>> {
  const { supabase, fromAddress, propertyId, role, contact } = input;
  try {
    const { data: prop, error: propErr } = await supabase
      .from("properties")
      .select("id, homeowner_contact_id, agent_contact_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (propErr) {
      return err({ code: "PROPERTY_FETCH_FAILED", message: propErr.message });
    }
    if (!prop) {
      return err({
        code: "PROPERTY_NOT_FOUND",
        message: "Property does not exist.",
      });
    }

    const slotTaken =
      role === "homeowner"
        ? prop.homeowner_contact_id !== null
        : prop.agent_contact_id !== null;
    if (slotTaken) {
      return err({
        code: "PROPERTY_ROLE_TAKEN",
        message: `Property already has a ${role} contact. Clear it first or pick a different role.`,
      });
    }

    const { data: c, error: cErr } = await supabase
      .from("contacts")
      .insert({
        first_name: contact.firstName ?? null,
        last_name: contact.lastName ?? null,
        entity_name: contact.entityName ?? null,
        phone_1: fromAddress,
      })
      .select("id")
      .single();
    if (cErr || !c) {
      return err({
        code: "CONTACT_INSERT_FAILED",
        message: cErr?.message ?? "no contact id returned",
      });
    }

    const detailErr = await insertRoleDetail(supabase, c.id, role);
    if (detailErr) {
      await supabase.from("contacts").delete().eq("id", c.id);
      return err(detailErr);
    }

    const { error: linkErr } = await supabase
      .from("properties")
      .update(
        role === "homeowner"
          ? { homeowner_contact_id: c.id }
          : { agent_contact_id: c.id },
      )
      .eq("id", propertyId);
    if (linkErr) {
      await deleteRoleDetail(supabase, c.id, role);
      await supabase.from("contacts").delete().eq("id", c.id);
      return err({
        code: "PROPERTY_LINK_FAILED",
        message: linkErr.message,
      });
    }

    const { error: msgErr } = await supabase
      .from("messages")
      .update({ contact_id: c.id, property_id: propertyId })
      .eq("from_address", fromAddress)
      .is("contact_id", null);
    if (msgErr) {
      return err({
        code: "MESSAGE_BACKFILL_FAILED",
        message: msgErr.message,
      });
    }

    return ok({ contactId: c.id });
  } catch (e) {
    return errFromUnknown(e, "MERGE_TO_PROPERTY_FAILED");
  }
}

/**
 * Insert a homeowner_details or agent_details row. Returns an
 * AppErrorShape on failure; null on success.
 */
async function insertRoleDetail(
  supabase: SupabaseClient<Database>,
  contactId: string,
  role: ContactRole,
): Promise<AppErrorShape | null> {
  const { error } =
    role === "homeowner"
      ? await supabase.from("homeowner_details").insert({ contact_id: contactId })
      : await supabase.from("agent_details").insert({ contact_id: contactId });
  if (error) {
    return {
      code: role === "homeowner" ? "HOMEOWNER_DETAIL_FAILED" : "AGENT_DETAIL_FAILED",
      message: error.message,
    };
  }
  return null;
}

async function deleteRoleDetail(
  supabase: SupabaseClient<Database>,
  contactId: string,
  role: ContactRole,
): Promise<void> {
  if (role === "homeowner") {
    await supabase
      .from("homeowner_details")
      .delete()
      .eq("contact_id", contactId);
  } else {
    await supabase.from("agent_details").delete().eq("contact_id", contactId);
  }
}

export type DismissUnknownSenderInput = {
  supabase: SupabaseClient<Database>;
  fromAddress: string;
};

export async function dismissUnknownSender(
  input: DismissUnknownSenderInput,
): Promise<Result<{ updated: number }>> {
  try {
    const { data, error } = await input.supabase
      .from("messages")
      .update({ dismissed_at: new Date().toISOString() })
      .eq("from_address", input.fromAddress)
      .is("contact_id", null)
      .is("dismissed_at", null)
      .select("id");
    if (error) {
      return err({ code: "DISMISS_FAILED", message: error.message });
    }
    return ok({ updated: data?.length ?? 0 });
  } catch (e) {
    return errFromUnknown(e, "DISMISS_FAILED");
  }
}

export async function restoreDismissedSender(
  input: DismissUnknownSenderInput,
): Promise<Result<{ updated: number }>> {
  try {
    const { data, error } = await input.supabase
      .from("messages")
      .update({ dismissed_at: null })
      .eq("from_address", input.fromAddress)
      .is("contact_id", null)
      .not("dismissed_at", "is", null)
      .select("id");
    if (error) {
      return err({ code: "RESTORE_FAILED", message: error.message });
    }
    return ok({ updated: data?.length ?? 0 });
  } catch (e) {
    return errFromUnknown(e, "RESTORE_FAILED");
  }
}

// Re-export the AppErrorShape so callers can narrow on .error.code.
export type { AppErrorShape };
