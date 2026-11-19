"use server";

import { resolveEffectiveHomeownerContactId } from "@/lib/leads/effective-homeowner";
import { assertNotTrainingTarget } from "@/lib/leads/training";
import { getCallerMembershipsOrThrow } from "@/lib/auth/memberships";
import { assertPropertyDncUnlocked } from "@/lib/dnc/property-lock";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { resolveInboundStamp } from "@/lib/messaging/inbound-stamp";
import { dispatchRepSms, readRepSmsContext } from "@/lib/messaging/rep-sms";
import { sendSmsToContact } from "@/lib/messaging/send";
import { createClient } from "@/lib/supabase/server";

import type { SendSmsPayload } from "./actions";

/**
 * `sendSmsFromLead` plus the reply-to stamp. Kept in its own file because
 * `leads/actions.ts` is frozen by CI; the send logic mirrors that action
 * exactly and only adds `inboundMessageId`, stamped as top-level
 * `metadata.inbound_message_id` after server-side validation (inbound, same
 * org, same property; otherwise silently dropped).
 */
export async function sendSmsFromLeadStamped(
  propertyId: string,
  body: string,
  from?: string | null,
  queueOnly?: boolean,
  to?: string | null,
  inboundMessageId?: string | null,
): Promise<Result<SendSmsPayload>> {
  const trimmed = body.trim();
  if (!trimmed) {
    return {
      ok: false,
      error: { code: "EMPTY_BODY", message: "Message body is empty." },
    };
  }
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
    const memberships = await getCallerMembershipsOrThrow();
    if (!memberships.length) throw new Error("Sign in to send a message.");
    if (memberships.some(m => m.acquisitions_enabled && m.role !== "owner")) {
      if (queueOnly) throw new Error("Rep texts must be sent immediately.");
      const context = await readRepSmsContext(propertyId);
      const sender = from ? context.senders.find(s => s.number === from) : context.senders.find(s => s.isDefault);
      if (!sender) throw new Error("Choose a texting number assigned to you.");
      return ok({ outcome: await dispatchRepSms({ propertyId, assignmentId: sender.id, body: trimmed, to, inboundMessageId }) });
    }
    const supabase = await createClient();
    await assertNotTrainingTarget(supabase, { propertyId });
    const unlocked = await assertPropertyDncUnlocked(supabase, propertyId);
    if (!unlocked.ok) return unlocked;

    const { data: property, error } = await supabase
      .from("properties")
      .select("id, org_id, homeowner_contact_id")
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
    const homeownerContactId = await resolveEffectiveHomeownerContactId(supabase, {
      propertyId,
      homeownerContactId: property.homeowner_contact_id,
    });
    if (!homeownerContactId) {
      return {
        ok: false,
        error: {
          code: "NO_HOMEOWNER_CONTACT",
          message: "Lead has no homeowner contact linked — add one first.",
        },
      };
    }

    const inboundStamp = inboundMessageId
      ? await resolveInboundStamp(supabase, inboundMessageId, {
          orgId: property.org_id,
          propertyId,
        })
      : null;
    const outcome = await sendSmsToContact(supabase, {
      origin: "manual",
      contactId: homeownerContactId,
      propertyId,
      body: trimmed,
      from: from ?? undefined,
      to: to ?? undefined,
      queueOnly: queueOnly ?? false,
      requireStickyFrom: true,
      // A captured id that fails validation is marked unresolved (not plainly
      // unstamped) so the classifier does not credit the text with replies that
      // arrived while it was being written.
      ...(inboundStamp
        ? { metadata: { inbound_message_id: inboundStamp } }
        : inboundMessageId
          ? { metadata: { inbound_stamp_unresolved: true } }
          : {}),
    });
    return ok({ outcome });
  } catch (e) {
    reportError(e, {
      tags: { surface: "send_sms_from_lead_stamped" },
      extra: { propertyId },
    });
    return errFromUnknown(e, "SEND_SMS_FAILED");
  }
}
