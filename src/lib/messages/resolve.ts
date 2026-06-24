import type { SupabaseClient } from "@supabase/supabase-js";

import { normalizePhone } from "@/lib/csv/normalize";
import {
  err,
  errFromUnknown,
  ok,
  type Result,
} from "@/lib/errors/result";
import type { ContactRole } from "@/lib/messages/triage";
import { ensureConversationIdForThread } from "@/lib/messages/threading";
import type { Database } from "@/lib/supabase/types";

export type ResolveThreadToExistingPropertyInput = {
  supabase: SupabaseClient<Database>;
  sourceConversationId: string;
  contactId: string;
  propertyId: string;
  role?: ContactRole | null;
};

export type CreatePropertyAndResolveInput = {
  supabase: SupabaseClient<Database>;
  sourceConversationId: string;
  contactId: string;
  role: ContactRole;
  property: {
    address: string;
    city?: string | null;
    state: string;
    zip?: string | null;
  };
};

export type ResolveThreadResult = {
  updated: number;
  conversationId: string;
};

type SourceValidation = {
  contactOrgId: string;
};

type PropertyValidation = {
  homeownerContactId: string | null;
  agentContactId: string | null;
};

type EnsureSnapshot = {
  hadRegistryRow: boolean;
  previouslyUnstampedDestinationMessageIds: string[];
};

type RoleSnapshot = {
  detailExisted: boolean;
  previousRoleContactId: string | null;
  propertyRoleUpdated: boolean;
};

export async function resolveThreadToExistingProperty(
  input: ResolveThreadToExistingPropertyInput,
): Promise<Result<ResolveThreadResult>> {
  const { supabase, sourceConversationId, contactId, propertyId, role } = input;
  const roleInput = validateOptionalRole(role);
  if (!roleInput.ok) return roleInput;
  let ensureSnapshot: EnsureSnapshot | null = null;
  let roleSnapshot: RoleSnapshot | null = null;
  let conversationId: string | null = null;
  try {
    const source = await validateSourceConversation(supabase, {
      sourceConversationId,
      contactId,
    });
    if (!source.ok) return source;

    const property = await validateProperty(supabase, {
      propertyId,
      contactOrgId: source.data.contactOrgId,
    });
    if (!property.ok) return property;

    const roleCheck = checkRoleOccupancy(property.data, contactId, roleInput.data);
    if (!roleCheck.ok) return roleCheck;

    ensureSnapshot = await snapshotEnsureSideEffects(supabase, {
      contactId,
      propertyId,
    });

    conversationId = await ensureConversationIdForThread(
      supabase,
      contactId,
      propertyId,
    );

    if (roleInput.data) {
      const roleResult = await applyRoleLink(supabase, {
        contactId,
        propertyId,
        orgId: source.data.contactOrgId,
        role: roleInput.data,
        previousRoleContactId:
          roleInput.data === "homeowner"
            ? property.data.homeownerContactId
            : property.data.agentContactId,
      });
      if (!roleResult.ok) {
        await rollbackEnsureSideEffects(supabase, ensureSnapshot, conversationId);
        return roleResult;
      }
      roleSnapshot = roleResult.data;
    }

    const restamp = await restampSourceMessages(supabase, {
      sourceConversationId,
      contactId,
      propertyId,
      conversationId,
    });
    if (!restamp.ok) {
      await rollbackRoleLink(supabase, {
        contactId,
        propertyId,
        role: roleInput.data,
        roleSnapshot,
      });
      await rollbackEnsureSideEffects(supabase, ensureSnapshot, conversationId);
      return restamp;
    }

    return ok({ updated: restamp.data.updated, conversationId });
  } catch (e) {
    await rollbackRoleLink(supabase, {
      contactId,
      propertyId,
      role: roleInput.data,
      roleSnapshot,
    });
    if (conversationId) {
      await rollbackEnsureSideEffects(supabase, ensureSnapshot, conversationId);
    }
    return errFromUnknown(e, "RESOLVE_THREAD_FAILED");
  }
}

export async function createPropertyAndResolve(
  input: CreatePropertyAndResolveInput,
): Promise<Result<ResolveThreadResult & { propertyId: string }>> {
  const { supabase, sourceConversationId, contactId, role, property } = input;
  const roleInput = validateRequiredRole(role);
  if (!roleInput.ok) return roleInput;
  let propertyId: string | null = null;
  let detailExisted = false;
  let ensureSnapshot: EnsureSnapshot | null = null;
  let conversationId: string | null = null;
  try {
    if (!property.address.trim() || property.state.trim().length !== 2) {
      return err({
        code: "INVALID_PROPERTY",
        message: "Address and two-letter state are required.",
      });
    }

    const source = await validateSourceConversation(supabase, {
      sourceConversationId,
      contactId,
    });
    if (!source.ok) return source;

    const detailBefore = await roleDetailExists(supabase, contactId, role);
    if (!detailBefore.ok) return detailBefore;
    detailExisted = detailBefore.data;

    const { data: inserted, error: insertError } = await supabase
      .from("properties")
      .insert({
        address: property.address.trim(),
        city: property.city?.trim() || null,
        state: property.state.trim().toUpperCase(),
        zip: property.zip?.trim() || null,
        status: "new_lead",
        org_id: source.data.contactOrgId,
        homeowner_contact_id: roleInput.data === "homeowner" ? contactId : null,
        agent_contact_id: roleInput.data === "agent" ? contactId : null,
      })
      .select("id")
      .single();
    if (insertError || !inserted) {
      return err({
        code: "PROPERTY_INSERT_FAILED",
        message: insertError?.message ?? "no property id returned",
      });
    }
    propertyId = inserted.id;

    const detail = await upsertRoleDetail(
      supabase,
      contactId,
      roleInput.data,
      source.data.contactOrgId,
    );
    if (!detail.ok) {
      await deleteInsertedProperty(supabase, propertyId);
      return detail;
    }

    ensureSnapshot = await snapshotEnsureSideEffects(supabase, {
      contactId,
      propertyId,
    });
    conversationId = await ensureConversationIdForThread(
      supabase,
      contactId,
      propertyId,
    );

    const restamp = await restampSourceMessages(supabase, {
      sourceConversationId,
      contactId,
      propertyId,
      conversationId,
    });
    if (!restamp.ok) {
      if (!detailExisted) await deleteRoleDetail(supabase, contactId, roleInput.data);
      await rollbackEnsureSideEffects(supabase, ensureSnapshot, conversationId);
      await deleteInsertedProperty(supabase, propertyId);
      return restamp;
    }

    return ok({ ...restamp.data, conversationId, propertyId });
  } catch (e) {
    if (propertyId) {
      if (!detailExisted) await deleteRoleDetail(supabase, contactId, roleInput.data);
      if (conversationId) {
        await rollbackEnsureSideEffects(supabase, ensureSnapshot, conversationId);
      }
      await deleteInsertedProperty(supabase, propertyId);
    }
    return errFromUnknown(e, "CREATE_PROPERTY_AND_RESOLVE_FAILED");
  }
}

function validateOptionalRole(
  role: ContactRole | null | undefined,
): Result<ContactRole | null> {
  if (role == null) return ok(null);
  if (role === "homeowner" || role === "agent") return ok(role);
  return invalidRole();
}

function validateRequiredRole(role: ContactRole): Result<ContactRole> {
  if (role === "homeowner" || role === "agent") return ok(role);
  return invalidRole();
}

function invalidRole(): Result<never> {
  return err({
    code: "INVALID_ROLE",
    message: "Role must be homeowner or agent.",
  });
}

async function validateSourceConversation(
  supabase: SupabaseClient<Database>,
  input: { sourceConversationId: string; contactId: string },
): Promise<Result<SourceValidation>> {
  const { data: rows, error } = await supabase
    .from("messages")
    .select("direction, from_address, to_address, contact_id, property_id, status")
    .eq("channel", "sms")
    .eq("conversation_id", input.sourceConversationId);
  if (error) {
    return err({ code: "SOURCE_FETCH_FAILED", message: error.message });
  }

  const contactPhones = new Set<string>();
  for (const row of rows ?? []) {
    const raw =
      row.direction === "inbound" ? row.from_address : row.to_address;
    const normalized = normalizePhone(raw);
    if (normalized) contactPhones.add(normalized);
  }
  if (contactPhones.size === 0) {
    return ambiguousContact();
  }

  const matches = await loadContactsByPhones(supabase, Array.from(contactPhones));
  if (!matches.ok) return matches;

  if (matches.data.length !== 1 || matches.data[0].id !== input.contactId) {
    return ambiguousContact();
  }

  const hasEligibleSourceRow = (rows ?? []).some(
    (row) =>
      row.contact_id === input.contactId &&
      row.property_id === null &&
      row.status !== "queued",
  );
  if (!hasEligibleSourceRow) {
    return err({
      code: "SOURCE_NO_ELIGIBLE_MESSAGES",
      message: "Source conversation has no propertyless non-queued messages to resolve.",
    });
  }

  return ok({ contactOrgId: matches.data[0].org_id });
}

function ambiguousContact(): Result<never> {
  return err({
    code: "AMBIGUOUS_CONTACT",
    message:
      "Source conversation does not map to exactly one matching contact.",
  });
}

async function loadContactsByPhones(
  supabase: SupabaseClient<Database>,
  phones: string[],
): Promise<Result<Array<{ id: string; org_id: string }>>> {
  const deduped = new Map<string, { id: string; org_id: string }>();
  for (const phone of phones) {
    const results = await Promise.all([
      supabase.from("contacts").select("id, org_id").eq("phone_1", phone),
      supabase.from("contacts").select("id, org_id").eq("phone_2", phone),
      supabase.from("contacts").select("id, org_id").eq("phone_3", phone),
    ]);
    for (const result of results) {
      if (result.error) {
        return err({
          code: "CONTACT_LOOKUP_FAILED",
          message: result.error.message,
        });
      }
      for (const row of result.data ?? []) {
        deduped.set(row.id, row);
      }
    }
  }
  return ok(Array.from(deduped.values()));
}

async function validateProperty(
  supabase: SupabaseClient<Database>,
  input: { propertyId: string; contactOrgId: string },
): Promise<Result<PropertyValidation>> {
  const { data: property, error } = await supabase
    .from("properties")
    .select("org_id, homeowner_contact_id, agent_contact_id, deleted_at")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (error) {
    return err({ code: "PROPERTY_FETCH_FAILED", message: error.message });
  }
  if (!property || property.org_id !== input.contactOrgId) {
    return err({
      code: "PROPERTY_FORBIDDEN",
      message: "Property is not available in the caller's organization.",
    });
  }
  if (property.deleted_at !== null) {
    return err({
      code: "PROPERTY_ARCHIVED",
      message: "Archived properties cannot be used to resolve conversations.",
    });
  }
  return ok({
    homeownerContactId: property.homeowner_contact_id,
    agentContactId: property.agent_contact_id,
  });
}

function checkRoleOccupancy(
  property: PropertyValidation,
  contactId: string,
  role?: ContactRole | null,
): Result<null> {
  if (!role) return ok(null);
  const occupant =
    role === "homeowner" ? property.homeownerContactId : property.agentContactId;
  if (occupant && occupant !== contactId) {
    return err({
      code: "PROPERTY_ROLE_TAKEN",
      message: `Property already has a ${role} contact.`,
    });
  }
  return ok(null);
}

async function snapshotEnsureSideEffects(
  supabase: SupabaseClient<Database>,
  input: { contactId: string; propertyId: string },
): Promise<EnsureSnapshot> {
  const [threadResult, messagesResult] = await Promise.all([
    supabase
      .from("message_threads")
      .select("conversation_id")
      .eq("channel", "sms")
      .eq("contact_id", input.contactId)
      .eq("property_id", input.propertyId)
      .maybeSingle(),
    supabase
      .from("messages")
      .select("id")
      .eq("channel", "sms")
      .eq("contact_id", input.contactId)
      .eq("property_id", input.propertyId)
      .is("conversation_id", null),
  ]);
  if (threadResult.error) {
    throw new Error(`snapshot message_threads: ${threadResult.error.message}`);
  }
  if (messagesResult.error) {
    throw new Error(`snapshot messages: ${messagesResult.error.message}`);
  }
  return {
    hadRegistryRow: Boolean(threadResult.data),
    previouslyUnstampedDestinationMessageIds: (messagesResult.data ?? []).map(
      (row) => row.id,
    ),
  };
}

async function rollbackEnsureSideEffects(
  supabase: SupabaseClient<Database>,
  snapshot: EnsureSnapshot | null,
  conversationId: string,
): Promise<void> {
  if (!snapshot) return;
  if (snapshot.previouslyUnstampedDestinationMessageIds.length > 0) {
    await supabase
      .from("messages")
      .update({ conversation_id: null })
      .in("id", snapshot.previouslyUnstampedDestinationMessageIds)
      .eq("conversation_id", conversationId);
  }
  if (!snapshot.hadRegistryRow) {
    await supabase
      .from("message_threads")
      .delete()
      .eq("conversation_id", conversationId);
  }
}

async function applyRoleLink(
  supabase: SupabaseClient<Database>,
  input: {
    contactId: string;
    propertyId: string;
    orgId: string;
    role: ContactRole;
    previousRoleContactId: string | null;
  },
): Promise<Result<RoleSnapshot>> {
  const detailBefore = await roleDetailExists(
    supabase,
    input.contactId,
    input.role,
  );
  if (!detailBefore.ok) return detailBefore;

  const detail = await upsertRoleDetail(
    supabase,
    input.contactId,
    input.role,
    input.orgId,
  );
  if (!detail.ok) return detail;

  let propertyRoleUpdated = false;
  if (input.previousRoleContactId === null) {
    const updateResult =
      input.role === "homeowner"
        ? await supabase
            .from("properties")
            .update({ homeowner_contact_id: input.contactId })
            .eq("id", input.propertyId)
            .is("homeowner_contact_id", null)
            .select("id")
            .maybeSingle()
        : await supabase
            .from("properties")
            .update({ agent_contact_id: input.contactId })
            .eq("id", input.propertyId)
            .is("agent_contact_id", null)
            .select("id")
            .maybeSingle();
    const { data, error } = updateResult;
    if (error) {
      if (!detailBefore.data) {
        await deleteRoleDetail(supabase, input.contactId, input.role);
      }
      return err({ code: "PROPERTY_LINK_FAILED", message: error.message });
    }
    if (!data) {
      if (!detailBefore.data) {
        await deleteRoleDetail(supabase, input.contactId, input.role);
      }
      return err({
        code: "PROPERTY_ROLE_TAKEN",
        message: `Property already has a ${input.role} contact.`,
      });
    }
    propertyRoleUpdated = true;
  }

  return ok({
    detailExisted: detailBefore.data,
    previousRoleContactId: input.previousRoleContactId,
    propertyRoleUpdated,
  });
}

async function rollbackRoleLink(
  supabase: SupabaseClient<Database>,
  input: {
    contactId: string;
    propertyId: string;
    role?: ContactRole | null;
    roleSnapshot: RoleSnapshot | null;
  },
): Promise<void> {
  if (!input.role || !input.roleSnapshot) return;
  if (input.roleSnapshot.propertyRoleUpdated) {
    await supabase
      .from("properties")
      .update(
        input.role === "homeowner"
          ? { homeowner_contact_id: input.roleSnapshot.previousRoleContactId }
          : { agent_contact_id: input.roleSnapshot.previousRoleContactId },
      )
      .eq("id", input.propertyId);
  }
  if (!input.roleSnapshot.detailExisted) {
    await deleteRoleDetail(supabase, input.contactId, input.role);
  }
}

async function roleDetailExists(
  supabase: SupabaseClient<Database>,
  contactId: string,
  role: ContactRole,
): Promise<Result<boolean>> {
  const { data, error } =
    role === "homeowner"
      ? await supabase
          .from("homeowner_details")
          .select("contact_id")
          .eq("contact_id", contactId)
          .maybeSingle()
      : await supabase
          .from("agent_details")
          .select("contact_id")
          .eq("contact_id", contactId)
          .maybeSingle();
  if (error) {
    return err({
      code:
        role === "homeowner"
          ? "HOMEOWNER_DETAIL_FETCH_FAILED"
          : "AGENT_DETAIL_FETCH_FAILED",
      message: error.message,
    });
  }
  return ok(Boolean(data));
}

async function upsertRoleDetail(
  supabase: SupabaseClient<Database>,
  contactId: string,
  role: ContactRole,
  orgId: string,
): Promise<Result<null>> {
  const { error } =
    role === "homeowner"
      ? await supabase
          .from("homeowner_details")
          .upsert(
            { contact_id: contactId, org_id: orgId },
            { onConflict: "contact_id" },
          )
      : await supabase
          .from("agent_details")
          .upsert(
            { contact_id: contactId, org_id: orgId },
            { onConflict: "contact_id" },
          );
  if (error) {
    return err({
      code:
        role === "homeowner" ? "HOMEOWNER_DETAIL_FAILED" : "AGENT_DETAIL_FAILED",
      message: error.message,
    });
  }
  return ok(null);
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

async function restampSourceMessages(
  supabase: SupabaseClient<Database>,
  input: {
    sourceConversationId: string;
    contactId: string;
    propertyId: string;
    conversationId: string;
  },
): Promise<Result<{ updated: number }>> {
  const { data, error } = await supabase
    .from("messages")
    .update({
      property_id: input.propertyId,
      conversation_id: input.conversationId,
    })
    .eq("channel", "sms")
    .eq("conversation_id", input.sourceConversationId)
    .eq("contact_id", input.contactId)
    .is("property_id", null)
    .neq("status", "queued")
    .select("id");
  if (error) {
    return err({ code: "MESSAGE_UPDATE_FAILED", message: error.message });
  }
  const updated = data?.length ?? 0;
  if (updated === 0) {
    return err({
      code: "SOURCE_NO_ELIGIBLE_MESSAGES",
      message: "Source conversation has no propertyless non-queued messages to resolve.",
    });
  }
  return ok({ updated });
}

async function deleteInsertedProperty(
  supabase: SupabaseClient<Database>,
  propertyId: string,
): Promise<void> {
  await supabase.from("properties").delete().eq("id", propertyId);
}
