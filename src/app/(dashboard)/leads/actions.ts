"use server";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { verifyPropertyAddress } from "@/lib/enrichment/verify-property";
import type { CassStatus } from "@/lib/enrichment/types";
import { qualifyProperty } from "@/lib/leads/qualify";
import {
  recordConsentEvent,
  type ConsentChannel,
  type ConsentEventType,
} from "@/lib/messaging/consent";
import { getMessagingProvider } from "@/lib/messaging/registry";
import {
  releaseQueuedMessage,
  sendSmsToContact,
  type SendSmsOutcome,
} from "@/lib/messaging/send";
import type { DialpadFromOption } from "@/lib/messaging/types";
import type { Database } from "@/lib/supabase/types";

export type PropertyStatus =
  | "prospect"
  | "new_lead"
  | "contacted"
  | "interested"
  | "offer_sent"
  | "offer_declined"
  | "under_contract"
  | "closed"
  | "dead";

const VALID_STATUSES: readonly PropertyStatus[] = [
  "prospect",
  "new_lead",
  "contacted",
  "interested",
  "offer_sent",
  "offer_declined",
  "under_contract",
  "closed",
  "dead",
];

type ContactRow = Database["public"]["Tables"]["contacts"]["Row"];
type HomeownerDetailsRow =
  Database["public"]["Tables"]["homeowner_details"]["Row"];
type AgentDetailsRow = Database["public"]["Tables"]["agent_details"]["Row"];
type PropertyRow = Database["public"]["Tables"]["properties"]["Row"];

export type DetailedLead = PropertyRow & {
  homeowner: (ContactRow & { homeowner_details: HomeownerDetailsRow | null }) | null;
  agent: (ContactRow & { agent_details: AgentDetailsRow | null }) | null;
};

export async function getLeadDetail(
  propertyId: string,
): Promise<Result<DetailedLead | null>> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("properties")
      .select(
        `*,
         homeowner:contacts!properties_homeowner_contact_id_fkey(
           *,
           homeowner_details(*)
         ),
         agent:contacts!properties_agent_contact_id_fkey(
           *,
           agent_details(*)
         )`,
      )
      .eq("id", propertyId)
      .maybeSingle();

    if (error) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: error.message },
      };
    }
    return ok(data as DetailedLead | null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "get_lead_detail" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "LEAD_FETCH_FAILED");
  }
}

export type VerifyResult = {
  cassStatus: CassStatus;
  standardized: string;
  isVacant: boolean | null;
  cacheHit: boolean;
};

export async function verifyLeadAddress(
  propertyId: string,
): Promise<Result<VerifyResult>> {
  try {
    const supabase = await createClient();
    const outcome = await verifyPropertyAddress(supabase, propertyId);

    switch (outcome.status) {
      case "verified":
      case "stored_with_status":
        return ok({
          cassStatus: outcome.verified.cassStatus,
          standardized: outcome.verified.standardized,
          isVacant: outcome.verified.isVacant ?? null,
          cacheHit: outcome.cacheHit,
        });
      case "provider_off":
        return {
          ok: false,
          error: {
            code: "PROVIDER_NOT_CONFIGURED",
            message:
              "Address verification is off. Set ADDRESS_VERIFIER_PROVIDER in .env.local to enable it.",
          },
        };
      case "not_found":
        return {
          ok: false,
          error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
        };
      case "no_result":
        return {
          ok: false,
          error: {
            code: "VERIFICATION_FAILED",
            message: "Provider returned no result.",
          },
        };
      case "failed":
        return {
          ok: false,
          error: {
            code: "VERIFICATION_FAILED",
            message: outcome.error,
          },
        };
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "verify_lead_address" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "VERIFICATION_FAILED");
  }
}

export type MotivationLevel = "hot" | "warm" | "cold";

const VALID_MOTIVATION_LEVELS: readonly MotivationLevel[] = [
  "hot",
  "warm",
  "cold",
];

/**
 * Set (or clear) the motivation level on a lead. Lives alongside status
 * as a separate axis — "how hot is the seller" vs "where in the pipeline".
 * `null` clears the temperature (e.g. requalification reset).
 */
export async function updateLeadMotivation(
  propertyId: string,
  level: MotivationLevel | null,
): Promise<Result<null>> {
  if (level !== null && !VALID_MOTIVATION_LEVELS.includes(level)) {
    return {
      ok: false,
      error: {
        code: "INVALID_MOTIVATION",
        message: `Unknown motivation level: ${level}`,
      },
    };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("properties")
      .update({
        motivation_level: level,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId);

    if (error) {
      return {
        ok: false,
        error: { code: "MOTIVATION_UPDATE_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_lead_motivation" },
      extra: { propertyId, level },
    });
    return errFromUnknown(e, "MOTIVATION_UPDATE_FAILED");
  }
}

/**
 * Promote a prospect to `new_lead`. Stamps qualified_at + qualified_by so
 * we know when and how the lead entered the working pipeline. Idempotent:
 * calling qualifyLead() on an already-qualified lead is a no-op that
 * returns ok.
 *
 * The `qualifier` is either a user id (manual action from /properties) or
 * a system marker like 'system:inbound_reply' (auto-qualify from the
 * Dialpad webhook).
 */
export async function qualifyLead(
  propertyId: string,
  qualifier: string | null = null,
): Promise<Result<{ alreadyQualified: boolean }>> {
  try {
    const supabase = await createClient();

    // Resolve the qualifier — explicit arg wins, else use the session user.
    let qualifiedBy = qualifier;
    if (!qualifiedBy) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      qualifiedBy = user?.id ?? null;
    }

    const outcome = await qualifyProperty(supabase, propertyId, qualifiedBy);
    switch (outcome.status) {
      case "qualified":
        return ok({ alreadyQualified: false });
      case "already_qualified":
        return ok({ alreadyQualified: true });
      case "not_found":
        return {
          ok: false,
          error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
        };
      case "failed":
        return {
          ok: false,
          error: { code: "QUALIFY_FAILED", message: outcome.message },
        };
    }
  } catch (e) {
    reportError(e, {
      tags: { surface: "qualify_lead" },
      extra: { propertyId, qualifier },
    });
    return errFromUnknown(e, "QUALIFY_FAILED");
  }
}

/**
 * Bulk variant — qualify a batch of prospects in one action. Runs the
 * qualify logic per-property serially (the volumes here are tens, not
 * thousands — no parallelism needed). Returns the counts.
 */
export async function qualifyLeadsBulk(
  propertyIds: string[],
): Promise<Result<{ qualified: number; alreadyQualified: number }>> {
  if (propertyIds.length === 0) {
    return ok({ qualified: 0, alreadyQualified: 0 });
  }
  let qualified = 0;
  let alreadyQualified = 0;
  try {
    for (const id of propertyIds) {
      const r = await qualifyLead(id);
      if (!r.ok) {
        return {
          ok: false,
          error: { code: "QUALIFY_BULK_FAILED", message: r.error.message },
        };
      }
      if (r.data.alreadyQualified) alreadyQualified++;
      else qualified++;
    }
    return ok({ qualified, alreadyQualified });
  } catch (e) {
    reportError(e, {
      tags: { surface: "qualify_leads_bulk" },
      extra: { count: propertyIds.length },
    });
    return errFromUnknown(e, "QUALIFY_BULK_FAILED");
  }
}

export async function updatePropertyStatus(
  propertyId: string,
  status: PropertyStatus,
): Promise<Result<null>> {
  if (!VALID_STATUSES.includes(status)) {
    return {
      ok: false,
      error: {
        code: "INVALID_STATUS",
        message: `Unknown status: ${status}`,
      },
    };
  }

  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("properties")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", propertyId);

    if (error) {
      return {
        ok: false,
        error: {
          code: "STATUS_UPDATE_FAILED",
          message: error.message,
        },
      };
    }

    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_property_status" },
      extra: { propertyId, status },
    });
    return errFromUnknown(e, "STATUS_UPDATE_FAILED");
  }
}

// ============================================================================
// SMS messaging (Phase 1 — Dialpad via MessagingProvider adapter)
// ============================================================================

export type SendSmsPayload = {
  outcome: SendSmsOutcome;
};

/**
 * Pull the list of numbers on the Dialpad account, with owner names
 * resolved, for the composer's "send from" dropdown. Safe to call
 * from any authed user — read-only.
 */
export async function listFromNumbers(): Promise<Result<DialpadFromOption[]>> {
  try {
    const provider = getMessagingProvider();
    if (!provider || !provider.listFromNumbers) {
      return ok([]);
    }
    const numbers = await provider.listFromNumbers();
    return ok(numbers);
  } catch (e) {
    reportError(e, { tags: { surface: "list_from_numbers" } });
    return errFromUnknown(e, "LIST_FROM_NUMBERS_FAILED");
  }
}

export async function sendSmsFromLead(
  propertyId: string,
  body: string,
  from?: string | null,
  queueOnly?: boolean,
): Promise<Result<SendSmsPayload>> {
  const trimmed = body.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: { code: "EMPTY_BODY", message: "Message body is empty." },
    };
  }
  // 1600 is a comfortable hard cap — Dialpad / carriers chunk beyond
  // 160 chars anyway but we prevent runaway copy/paste of novels.
  if (trimmed.length > 1600) {
    return {
      ok: false,
      error: {
        code: "BODY_TOO_LONG",
        message: `Message is ${trimmed.length} characters — cap is 1600.`,
      },
    };
  }

  try {
    const supabase = await createClient();

    const { data: property, error } = await supabase
      .from("properties")
      .select("id, homeowner_contact_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (error) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: error.message },
      };
    }
    if (!property) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }
    if (!property.homeowner_contact_id) {
      return {
        ok: false,
        error: {
          code: "NO_HOMEOWNER_CONTACT",
          message: "Lead has no homeowner contact linked — add one first.",
        },
      };
    }

    const outcome = await sendSmsToContact(supabase, {
      contactId: property.homeowner_contact_id,
      propertyId,
      body: trimmed,
      from: from ?? undefined,
      queueOnly: queueOnly ?? false,
    });
    return ok({ outcome });
  } catch (e) {
    reportError(e, {
      tags: { surface: "send_sms_from_lead" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "SEND_SMS_FAILED");
  }
}

/**
 * Manual consent capture from the lead-detail composer. The operator
 * asserts they have written proof (a signed form or a screenshot of an
 * opt-in form submission) and records an `opt_in_marketing_written`
 * event. UI prompts for the source URL / description.
 */
export async function captureConsent(params: {
  contactId: string;
  channel: ConsentChannel;
  eventType: ConsentEventType;
  source: string;
}): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    await recordConsentEvent(supabase, params);
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "capture_consent" },
      extra: { contactId: params.contactId },
    });
    return errFromUnknown(e, "CONSENT_CAPTURE_FAILED");
  }
}

// ============================================================================
// VA polish seams — Feature 1 (migration 010)
// Lead assignment · unread indicator · activity notes
// ============================================================================

export type TeamMember = {
  id: string;
  email: string;
};

/**
 * List authed team members for assignee pickers. Uses the admin client
 * because `auth.admin.listUsers()` requires service role, but we limit
 * the returned shape to {id, email} — no sign-in timestamps or metadata
 * leak through. Middleware already gates `/leads/**` behind auth, so any
 * caller reaching this action is already a trusted org member.
 */
export async function listOrgUsers(): Promise<Result<TeamMember[]>> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 200 });
    if (error) {
      return {
        ok: false,
        error: { code: "TEAM_FETCH_FAILED", message: error.message },
      };
    }
    const members: TeamMember[] = (data?.users ?? [])
      .filter((u) => !!u.email)
      .map((u) => ({ id: u.id, email: u.email as string }))
      .sort((a, b) => a.email.localeCompare(b.email));
    return ok(members);
  } catch (e) {
    reportError(e, { tags: { surface: "list_org_users" } });
    return errFromUnknown(e, "TEAM_FETCH_FAILED");
  }
}

/**
 * Assign (or unassign) a lead to a team member. `userId = null` clears
 * the assignment. Returns `{ ok: true }` on success regardless of
 * whether the value actually changed.
 */
export async function updateLeadAssignee(
  propertyId: string,
  userId: string | null,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("properties")
      .update({
        assigned_user_id: userId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", propertyId);
    if (error) {
      return {
        ok: false,
        error: { code: "ASSIGNEE_UPDATE_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "update_lead_assignee" },
      extra: { propertyId, userId },
    });
    return errFromUnknown(e, "ASSIGNEE_UPDATE_FAILED");
  }
}

/**
 * Mark all unread inbound messages for a property as read. Called from
 * the lead-detail server component on every page load so opening a lead
 * acknowledges the thread. Uses the partial index on
 * `(property_id, created_at desc) where direction='inbound' and read_at is null`.
 */
export async function markMessagesReadForProperty(
  propertyId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const { error } = await supabase
      .from("messages")
      .update({ read_at: new Date().toISOString() })
      .eq("property_id", propertyId)
      .eq("direction", "inbound")
      .is("read_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "MARK_READ_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "mark_messages_read" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "MARK_READ_FAILED");
  }
}

/**
 * Append an activity note to a lead. Notes are authored by the current
 * session user; an unauthenticated call is rejected rather than producing
 * an orphan note. Realtime subscribers on `lead_notes` get the INSERT.
 */
export async function createLeadNote(
  propertyId: string,
  body: string,
): Promise<Result<{ id: string }>> {
  const trimmed = body.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: { code: "EMPTY_BODY", message: "Note body is empty." },
    };
  }
  if (trimmed.length > 5000) {
    return {
      ok: false,
      error: {
        code: "BODY_TOO_LONG",
        message: `Note is ${trimmed.length} characters — cap is 5000.`,
      },
    };
  }

  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in." },
      };
    }

    // Look up the property's org to stamp the note correctly. Every property
    // has an org_id (NOT NULL in schema) so this is never missing in practice.
    const { data: property, error: lookupErr } = await supabase
      .from("properties")
      .select("org_id")
      .eq("id", propertyId)
      .maybeSingle();
    if (lookupErr) {
      return {
        ok: false,
        error: { code: "LEAD_FETCH_FAILED", message: lookupErr.message },
      };
    }
    if (!property) {
      return {
        ok: false,
        error: { code: "LEAD_NOT_FOUND", message: "Lead not found." },
      };
    }

    const { data: inserted, error } = await supabase
      .from("lead_notes")
      .insert({
        org_id: property.org_id,
        property_id: propertyId,
        author_user_id: user.id,
        body: trimmed,
      })
      .select("id")
      .single();

    if (error) {
      return {
        ok: false,
        error: { code: "NOTE_CREATE_FAILED", message: error.message },
      };
    }
    return ok({ id: inserted.id });
  } catch (e) {
    reportError(e, {
      tags: { surface: "create_lead_note" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "NOTE_CREATE_FAILED");
  }
}
