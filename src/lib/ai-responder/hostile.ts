/**
 * Hostile-inbound detection (Messages v2, hostile / wrong-number replies).
 *
 * The phrase list below is business-rule text. Approved verbatim by Jarrad
 * 2026-10-07. No LLM or engineer may add, edit, merge, replace or remove an
 * entry unless a human approved that exact text; `hostile.test.ts` pins the
 * list byte for byte.
 *
 * Matching: case-insensitive, anywhere in the inbound text (substring, no
 * word boundaries), exactly as approved.
 */
export const HOSTILE_PHRASES = [
  "fuck",
  "scam",
  "spam",
  "leave me alone",
  "piss",
  "asshole",
  "bitch",
  "idiot",
  "stalk",
  "never contact",
  "do not contact",
  "quit texting",
  "stop texting",
  "stop contacting",
  "f off",
  "go to hell",
  "harass",
] as const;

export function isHostileInbound(body: string | null | undefined): boolean {
  if (typeof body !== "string" || body.length === 0) return false;
  const text = body.toLowerCase();
  return HOSTILE_PHRASES.some((phrase) => text.includes(phrase));
}

/**
 * Hold reason for a hostile conversation. Hostile wording is never an
 * automatic do-not-contact decision: a person confirms it from the hold card
 * ("Confirm do-not-contact"), which suppresses the number and then sends the
 * approved hostile reply.
 */
export const HOSTILE_NEEDS_CONFIRM_REASON = "hostile_needs_confirm";

/** Hold reason for an opt-out PHRASE that is not on the hostile list ("remove me", ...). Same human confirm action. */
export const OPTOUT_PHRASE_NEEDS_CONFIRM_REASON = "optout_phrase_needs_confirm";

/** True for either "needs a person to confirm do-not-contact" hold reason (with or without an `:<inboundId>` suffix). */
export function isConfirmDncReason(reason: string | null | undefined): boolean {
  return (
    !!reason &&
    (reason.startsWith(HOSTILE_NEEDS_CONFIRM_REASON) || reason.startsWith(OPTOUT_PHRASE_NEEDS_CONFIRM_REASON))
  );
}

/** The originating inbound message id carried in the hold reason, or null. */
export function confirmDncInboundId(reason: string | null | undefined): string | null {
  if (!isConfirmDncReason(reason)) return null;
  const id = reason!.split(":")[1];
  return id ? id : null;
}
