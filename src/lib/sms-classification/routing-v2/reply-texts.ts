import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import { IDENTITY_REPLY_BODY } from "@/lib/ai-responder/identity";

import { NINE_HOT_REPLY_TEXTS } from "../nine-questions";

/**
 * SMS reply routing v2 (PR-B) — the approved reply texts, character for character.
 *
 * BUSINESS RULES. Sources:
 * - vault note "2026-10-29 — Sandra SMS reply routing plan (Jev + Haiku)", section
 *   "Approved reply texts" (price too high, no repairs, number source, driving, located,
 *   which property, text only, how it works);
 * - the fair-price reply approved by Jarrad 2026-10-30 (build brief, BUILD-PLAN §5 PR-B);
 * - existing approved replies reused by reference, never copied: wrong number / not
 *   interested / nurture (`approved-reply-texts.ts`, 2026-10-07), asked for offer / said yes /
 *   named a price (`NINE_HOT_REPLY_TEXTS`, 2026-10-20), who is texting (`IDENTITY_REPLY_BODY`).
 *
 * No LLM or engineer may edit, reword, add or remove a text without Jarrad approving that
 * exact text. `routing-v2-actions.test.ts` pins every byte. These are seeded into the Templates
 * library UNAPPROVED; nothing sends until an owner approves the template AND
 * `routing_v2_flags.replies` is on.
 */
export const V2_REPLY_TEXTS = {
  number_source:
    "Fair question. Your property met the criteria in our public records search. We're buying in your area. Would you consider an offer?",
  where_property: "Sorry for the confusion, it's {{property_address}}. Would you consider a cash offer on it?",
  where_located: "We're based in the Kansas City metro, but we buy properties throughout the Midwest.",
  text_only:
    "Thanks for making me aware. We have several questions about the condition of the property. Are you OK answering those via text?",
  /** The one approved 2-segment exception (longer than 160 characters on purpose). */
  how_it_works:
    "Thanks for your question. First step is a conversation about the condition of the property. With that information we get you an approval for an offer. If you like the offer, we open title, schedule a walk through with our contractors, and close in 14-30 days.",
  driving: "Okay, thank you for letting me know. I'll reach out to you later.",
  price_too_high:
    "What you're asking is actually above what we would want to list for after repairs. It sounds like your property is realtor-approved and list-ready, no repairs?",
  no_repairs_realtor:
    "Thank you for being transparent. For most homeowners, a realtor is the best option. Do you think a realtor would be most helpful for you?",
  fair_price: "My team member is going to be reaching out to you here shortly.",
} as const;

export type V2ReplyKey = keyof typeof V2_REPLY_TEXTS;

/** New `auto_reply_templates.outcome` keys added by 20261030131000 (number_source already existed). */
export const V2_TEMPLATE_KEYS = [
  "where_property",
  "where_located",
  "text_only",
  "how_it_works",
  "driving",
  "price_too_high",
  "no_repairs_realtor",
  "fair_price",
] as const satisfies ReadonlyArray<V2ReplyKey>;

/** Keys allowed to exceed one SMS segment (Jarrad: how-it-works is the 2-part exception). */
export const V2_MULTI_SEGMENT_KEYS: ReadonlySet<V2ReplyKey> = new Set(["how_it_works"]);

/** Existing approved replies the v2 roads reuse (referenced, not copied). */
export const V2_REUSED_REPLY_TEXTS = {
  wrong_number: APPROVED_REPLY_TEXTS.wrong_number,
  not_interested: APPROVED_REPLY_TEXTS.not_interested,
  nurture: APPROVED_REPLY_TEXTS.nurture,
  asked_offer: NINE_HOT_REPLY_TEXTS.asked_offer,
  said_yes: NINE_HOT_REPLY_TEXTS.said_yes,
  named_price: NINE_HOT_REPLY_TEXTS.named_price,
  identity: IDENTITY_REPLY_BODY,
} as const;

export type V2ReusedReplyKey = keyof typeof V2_REUSED_REPLY_TEXTS;
export type V2AnyReplyKey = V2ReplyKey | V2ReusedReplyKey;

export function v2ReplyText(key: V2AnyReplyKey): string {
  return key in V2_REPLY_TEXTS ? V2_REPLY_TEXTS[key as V2ReplyKey] : V2_REUSED_REPLY_TEXTS[key as V2ReusedReplyKey];
}

export const V2_REPLY_APPROVAL_NOTE = "Routing v2 text approved by Jarrad 2026-10-29/30; click Approve to enable";
export const V2_REPLY_CATEGORY = "Auto replies";
export const V2_REPLY_NAMES: Record<V2ReplyKey, string> = {
  number_source: `Auto reply v2: How did you get my number | ${V2_REPLY_APPROVAL_NOTE}`,
  where_property: `Auto reply v2: Which property | ${V2_REPLY_APPROVAL_NOTE}`,
  where_located: `Auto reply v2: Where located | ${V2_REPLY_APPROVAL_NOTE}`,
  text_only: `Auto reply v2: Text only | ${V2_REPLY_APPROVAL_NOTE}`,
  how_it_works: `Auto reply v2: How it works | ${V2_REPLY_APPROVAL_NOTE}`,
  driving: `Auto reply v2: Driving | ${V2_REPLY_APPROVAL_NOTE}`,
  price_too_high: `Auto reply v2: Price too high (repairs) | ${V2_REPLY_APPROVAL_NOTE}`,
  no_repairs_realtor: `Auto reply v2: No repairs (realtor) | ${V2_REPLY_APPROVAL_NOTE}`,
  fair_price: `Auto reply v2: Fair price | ${V2_REPLY_APPROVAL_NOTE}`,
};
