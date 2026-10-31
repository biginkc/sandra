import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveApprovedTemplateReply, selectAutoReplyTemplate, type TemplateCandidate, type TemplateRow } from "@/lib/ai-responder/template-reply";
import { renderReviewedReply } from "@/lib/inbox/reply-template";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import type { Database } from "@/lib/supabase/types";
import { readRoutingV2Flags, v2SliceAllowed } from "./flags";
import { v2ReplyText, type V2AnyReplyKey } from "./reply-texts";

export type V2ResolvedReply =
  | { kind: "ready"; body: string; source: string; templateId: string | null; fixed: boolean }
  | { kind: "none"; reason: string };

const FIXED: ReadonlySet<V2AnyReplyKey> = new Set(["identity", "asked_offer", "said_yes", "named_price"]);
type Mapping = {
  id: string; template_id: string; reply_intent: string | null; priority: number;
  sms_templates: TemplateRow | TemplateRow[] | null;
};

/** Prepare approved content only. This does not send, reserve or suppress. The transport
 * must recheck approval at its provider boundary, using templateId and the unrendered source.
 * Legacy label switches still apply to nurture/not-interested/wrong-number.
 */
export async function resolveV2Reply(
  db: SupabaseClient<Database>,
  input: { orgId: string; propertyId: string; contactId: string; key: V2AnyReplyKey },
): Promise<V2ResolvedReply> {
  const { orgId, propertyId, contactId, key } = input;
  try {
    const flags = await readRoutingV2Flags(db, orgId);
    if (!v2SliceAllowed(flags, "replies", propertyId)) return { kind: "none", reason: "flag_off" };
    const approved = v2ReplyText(key);
    if (FIXED.has(key)) return { kind: "ready", body: approved, source: approved, templateId: null, fixed: true };
    if (key === "nurture" || key === "not_interested" || key === "wrong_number") {
      const resolved = await resolveApprovedTemplateReply(db, {
        orgId, propertyId, contactId, outcome: key, outcomeConfidence: null,
        escalationReason: "not_applicable", decidedBy: "nine_questions",
      });
      if (resolved.kind === "none") return resolved;
      if (resolved.body !== approved || resolved.source !== approved) return { kind: "none", reason: "reply_text_not_approved" };
      return { kind: "ready", body: resolved.body, source: approved, templateId: resolved.templateId, fixed: false };
    }
    const { data, error } = await db.from("auto_reply_templates")
      .select("id, template_id, reply_intent, priority, sms_templates(content, approved_for_auto_send, approved_content, deleted_at)")
      .eq("org_id", orgId).eq("outcome", key).eq("active", true);
    if (error || !data) return { kind: "none", reason: "lookup_failed" };
    const candidates: TemplateCandidate[] = (data as unknown as Mapping[]).map((row) => ({
      mappingId: row.id, templateId: row.template_id, replyIntent: row.reply_intent, priority: row.priority,
      template: Array.isArray(row.sms_templates) ? row.sms_templates[0] ?? null : row.sms_templates,
    }));
    const chosen = selectAutoReplyTemplate(candidates, null);
    if (chosen.kind === "none") return chosen;
    // Source must match before rendering too: a different approved template that happens
    // to render identically must not silently replace the word-for-word routing contract.
    if (chosen.candidate.template.content !== approved) return { kind: "none", reason: "reply_text_not_approved" };
    const vars = await loadTemplateVars(db, { propertyId, contactId });
    const body = renderReviewedReply(approved, vars);
    return { kind: "ready", body, source: approved, templateId: chosen.candidate.templateId, fixed: false };
  } catch {
    return { kind: "none", reason: "reply_preparation_failed" };
  }
}
