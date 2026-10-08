"use server";

import { revalidatePath } from "next/cache";

import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";
import { createClient } from "@/lib/supabase/server";

import {
  AUTO_REPLY_OUTCOMES,
  type AutoReplyMapping,
  type AutoReplyOutcome,
  type AutoReplySettings,
} from "./auto-reply-types";

const OUTCOMES = new Set<string>(AUTO_REPLY_OUTCOMES.map((o) => o.outcome));

function rpcMessage(message: string): string {
  if (message.includes("FORBIDDEN")) return "Only an org owner can do this.";
  if (message.includes("CONTENT_CHANGED")) {
    return "This template's text changed since you opened it. Reload the page and review the new text before approving.";
  }
  if (message.includes("TEMPLATE_DELETED") || message.includes("TEMPLATE_NOT_FOUND")) {
    return "Template not found or already deleted.";
  }
  if (message.includes("APPROVAL_RPC_ONLY")) return "Approval can only be changed from the Templates screen.";
  return message;
}

/**
 * Approve (or stop approving) a template for automatic replies. The approver
 * sends the exact text they were shown; the database refuses if it has since
 * changed, and records who approved and when. Owner-only (enforced by the RPC;
 * the UI hides the control from everyone else).
 */
export async function setTemplateAutoSendApproval(input: {
  templateId: string;
  approved: boolean;
  /** The exact text on screen when the owner confirmed. Required to approve. */
  expectedContent: string | null;
}): Promise<Result<{ approved: boolean }>> {
  if (input.approved && (input.expectedContent === null || input.expectedContent.length === 0)) {
    return { ok: false, error: { code: "VALIDATION", message: "The text being approved is required." } };
  }
  try {
    const supabase = await createClient();
    const { error } = await supabase.rpc("fn_set_template_auto_send_approval", {
      p_template_id: input.templateId,
      p_approved: input.approved,
      p_expected_content: input.approved ? input.expectedContent : null,
    });
    if (error) {
      return {
        ok: false,
        error: { code: "TPL_APPROVAL_FAILED", message: rpcMessage(error.message) },
      };
    }
    revalidatePath("/templates");
    return ok({ approved: input.approved });
  } catch (e) {
    reportError(e, { tags: { surface: "set_template_auto_send_approval" } });
    return errFromUnknown(e, "TPL_APPROVAL_FAILED");
  }
}

/** Current outcome -> template mappings and each label's automation switch. */
export async function listAutoReplySettings(): Promise<Result<AutoReplySettings | null>> {
  try {
    const supabase = await createClient();
    const { data: org } = await supabase.from("organizations").select("id").limit(1).maybeSingle();
    if (!org) return ok(null);

    const [mappingRes, thresholdRes] = await Promise.all([
      supabase
        .from("auto_reply_templates")
        .select("id, outcome, template_id, active, reply_intent")
        .eq("org_id", org.id)
        .is("reply_intent", null),
      supabase
        .from("jev_outcome_thresholds")
        .select("outcome, automation_enabled")
        .eq("org_id", org.id),
    ]);
    if (mappingRes.error) {
      return { ok: false, error: { code: "AUTO_REPLY_LIST_FAILED", message: mappingRes.error.message } };
    }
    const mappings: AutoReplyMapping[] = (mappingRes.data ?? [])
      .filter((m) => OUTCOMES.has(m.outcome))
      .map((m) => ({
        id: m.id,
        outcome: m.outcome as AutoReplyOutcome,
        templateId: m.template_id,
        active: m.active,
      }));
    const labelAutomation: AutoReplySettings["labelAutomation"] = {};
    for (const row of thresholdRes.error ? [] : (thresholdRes.data ?? [])) {
      if (OUTCOMES.has(row.outcome)) {
        labelAutomation[row.outcome as AutoReplyOutcome] = row.automation_enabled === true;
      }
    }
    return ok({ orgId: org.id, mappings, labelAutomation });
  } catch (e) {
    reportError(e, { tags: { surface: "list_auto_reply_settings" } });
    return errFromUnknown(e, "AUTO_REPLY_LIST_FAILED");
  }
}

/**
 * Map an outcome to a library template (any reply intent), switch it on/off,
 * or remove the mapping (`templateId: null`). A mapping to a template that is
 * not approved is inert; approval is a separate, explicit step. Owner-only
 * (enforced by the RPC).
 */
export async function setAutoReplyMapping(input: {
  outcome: string;
  templateId: string | null;
  active: boolean;
}): Promise<Result<null>> {
  if (!OUTCOMES.has(input.outcome)) {
    return { ok: false, error: { code: "VALIDATION", message: `Unsupported outcome: ${input.outcome}` } };
  }
  try {
    const supabase = await createClient();
    const { data: org } = await supabase.from("organizations").select("id").limit(1).maybeSingle();
    if (!org) {
      return { ok: false, error: { code: "NO_ORG", message: "No organization found." } };
    }
    const { data: existing, error: lookupError } = await supabase
      .from("auto_reply_templates")
      .select("id")
      .eq("org_id", org.id)
      .eq("outcome", input.outcome)
      .is("reply_intent", null);
    if (lookupError) {
      return { ok: false, error: { code: "AUTO_REPLY_SAVE_FAILED", message: lookupError.message } };
    }
    const rows = existing ?? [];

    if (input.templateId === null) {
      for (const row of rows) {
        const { error } = await supabase.rpc("fn_set_auto_reply_template", {
          p_org_id: org.id,
          p_outcome: input.outcome,
          p_reply_intent: null,
          p_template_id: null,
          p_mapping_id: row.id,
          p_delete: true,
        });
        if (error) {
          return { ok: false, error: { code: "AUTO_REPLY_SAVE_FAILED", message: rpcMessage(error.message) } };
        }
      }
    } else {
      const [first, ...extra] = rows;
      const { error } = await supabase.rpc("fn_set_auto_reply_template", {
        p_org_id: org.id,
        p_outcome: input.outcome,
        p_reply_intent: null,
        p_template_id: input.templateId,
        p_active: input.active,
        p_mapping_id: first?.id ?? null,
      });
      if (error) {
        return { ok: false, error: { code: "AUTO_REPLY_SAVE_FAILED", message: rpcMessage(error.message) } };
      }
      // The screen manages one any-intent mapping per outcome: drop strays.
      for (const row of extra) {
        await supabase.rpc("fn_set_auto_reply_template", {
          p_org_id: org.id,
          p_outcome: input.outcome,
          p_reply_intent: null,
          p_template_id: null,
          p_mapping_id: row.id,
          p_delete: true,
        });
      }
    }
    revalidatePath("/templates");
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "set_auto_reply_mapping" } });
    return errFromUnknown(e, "AUTO_REPLY_SAVE_FAILED");
  }
}
