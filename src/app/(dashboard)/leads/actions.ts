"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { verifyPropertyAddress } from "@/lib/enrichment/verify-property";
import type { CassStatus } from "@/lib/enrichment/types";
import {
  recordConsentEvent,
  type ConsentChannel,
  type ConsentEventType,
} from "@/lib/messaging/consent";
import { getMessagingProvider } from "@/lib/messaging/registry";
import { sendSmsToContact, type SendSmsOutcome } from "@/lib/messaging/send";
import type { DialpadFromOption } from "@/lib/messaging/types";
import type { Database } from "@/lib/supabase/types";

export type PropertyStatus =
  | "new_lead"
  | "contacted"
  | "interested"
  | "offer_sent"
  | "offer_declined"
  | "under_contract"
  | "closed"
  | "dead";

const VALID_STATUSES: readonly PropertyStatus[] = [
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
