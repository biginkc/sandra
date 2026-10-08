/**
 * The four reply texts Jarrad approved on 2026-10-07, character for
 * character. They are SEEDED into the Templates library UNAPPROVED
 * (`seed-reply-templates.ts`); an owner still has to click Approve in the
 * Templates UI before any of them can be sent automatically. No LLM or
 * engineer may edit, reword, merge or remove one of these strings unless a
 * human approved that exact text; `approved-reply-texts.test.ts` pins every
 * byte.
 *
 * This file is the single in-repo copy of the text (SQL and docs reference it,
 * they do not duplicate it).
 */
export const APPROVED_REPLY_TEXTS = {
  not_interested:
    "Sounds good, thanks for letting me know. If anything changes in the next 6-12 months, mind if I check back?",
  hostile: "Terribly sorry for the inconvenience. We've updated our records.",
  wrong_number:
    "Sorry about that, my mistake. I'll take this number off our list. Any chance you know who owns the place?",
  nurture: "Fantastic! We will keep in touch.",
} as const;

export type ApprovedReplyKey = keyof typeof APPROVED_REPLY_TEXTS;

export const APPROVAL_NOTE = "Text approved by Jarrad 2026-10-07; click Approve to enable";

/** Library category the seeded templates live under. */
export const APPROVED_REPLY_CATEGORY = "Auto replies";

/** Library entry names. The note rides in the name because the library has no notes column. */
export const APPROVED_REPLY_NAMES: Record<ApprovedReplyKey, string> = {
  not_interested: `Auto reply: Not interested | ${APPROVAL_NOTE}`,
  hostile: `Auto reply: Hostile | ${APPROVAL_NOTE}`,
  wrong_number: `Auto reply: Wrong number | ${APPROVAL_NOTE}`,
  nurture: `Auto reply: Nurture | ${APPROVAL_NOTE}`,
};
