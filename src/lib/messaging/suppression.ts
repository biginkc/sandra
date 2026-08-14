import type { ConsentState } from "./consent";

export const SUPPRESSED_DISPOS = new Set([
  "wrong_number",
  "bad_number",
  "dnc",
  "opted_out",
] as const);

type SuppressedDispo = typeof SUPPRESSED_DISPOS extends ReadonlySet<infer T>
  ? T
  : never;

export type SuppressionInput = {
  outreachDispo?: string | null;
  consentState?: ConsentState | null;
  doNotContact?: boolean | null;
  smsOptedOut?: boolean | null;
};

export type SuppressionDecision =
  | {
      suppressed: false;
    }
  | {
      suppressed: true;
      reason: string;
      source:
        | "outreach_dispo"
        | "consent_state"
        | "do_not_contact"
        | "phone_suppression"
        | "sms_opted_out"
        | "human_owned_dispo";
      outreachDispo?: string | null;
      consentState?: ConsentState | null;
    };

export function evaluateSuppression(
  input: SuppressionInput,
): SuppressionDecision {
  if (input.outreachDispo && SUPPRESSED_DISPOS.has(input.outreachDispo as SuppressedDispo)) {
    return {
      suppressed: true,
      source: "outreach_dispo",
      outreachDispo: input.outreachDispo,
      consentState: input.consentState ?? null,
      reason: `Property is suppressed by terminal disposition: ${input.outreachDispo}.`,
    };
  }

  if (input.doNotContact) {
    return {
      suppressed: true,
      source: "do_not_contact",
      outreachDispo: input.outreachDispo ?? null,
      consentState: input.consentState ?? null,
      reason: "Contact is marked do-not-contact.",
    };
  }

  if (input.smsOptedOut) {
    return {
      suppressed: true,
      source: "sms_opted_out",
      outreachDispo: input.outreachDispo ?? null,
      consentState: input.consentState ?? null,
      reason: "Contact is marked opted out of SMS.",
    };
  }

  if (input.consentState === "opted_out") {
    return {
      suppressed: true,
      source: "consent_state",
      outreachDispo: input.outreachDispo ?? null,
      consentState: input.consentState,
      reason: "Contact has opted out of SMS.",
    };
  }

  return { suppressed: false };
}

export function isSuppressed(input: SuppressionInput): boolean {
  return evaluateSuppression(input).suppressed;
}

/**
 * Dispositions that represent a human-owned outcome: nurture / callback /
 * a booked appointment. These are deliberately NOT in SUPPRESSED_DISPOS
 * above — SUPPRESSED_DISPOS blocks every sender (manual composer included)
 * for consent/compliance reasons, but a human agent must still be able to
 * manually text someone who just booked ("see you at 2pm tomorrow!") or is
 * in nurture. `shouldSuppressAutomatedSend` below is the authoritative
 * boundary for automated/unattended senders (AI responder, sequence tick,
 * bulk-queue) — it combines both sets so a future disposition only has to
 * be added in one place to be covered everywhere automated.
 */
export const HUMAN_OWNED_DISPOS = new Set([
  "nurture",
  "callback_requested",
  "booked_appointment",
] as const);

type HumanOwnedDispo = typeof HUMAN_OWNED_DISPOS extends ReadonlySet<infer T>
  ? T
  : never;

/**
 * The authoritative outbound suppression check for automated/unattended
 * senders — combines `evaluateSuppression`'s SUPPRESSED_DISPOS/consent/DNC
 * checks with the HUMAN_OWNED_DISPOS check, and is the ONLY function that
 * makes this decision. Every consumer that fires SMS without a human
 * reviewing that specific message body — the AI responder, sequence tick,
 * bulk-queue, and the queue-release path when the row's provenance is
 * `origin: 'automated'` — must gate on this before calling
 * `sendSmsToContact`/dispatching to the provider. `sendSmsToContact` itself
 * only enforces `isSuppressed` (SUPPRESSED_DISPOS) for its early check so
 * the manual reply composer stays unaffected by HUMAN_OWNED_DISPOS; it
 * separately re-runs `evaluateAutomatedSuppression` against FRESH state
 * immediately before the provider call, but only when the caller declared
 * `origin: 'automated'`.
 */
export function evaluateAutomatedSuppression(
  input: SuppressionInput,
): SuppressionDecision {
  const base = evaluateSuppression(input);
  if (base.suppressed) return base;
  if (
    input.outreachDispo &&
    HUMAN_OWNED_DISPOS.has(input.outreachDispo as HumanOwnedDispo)
  ) {
    return {
      suppressed: true,
      source: "human_owned_dispo",
      outreachDispo: input.outreachDispo,
      consentState: input.consentState ?? null,
      reason: `Property has a human-owned disposition: ${input.outreachDispo}. Automated sends are suppressed.`,
    };
  }
  return { suppressed: false };
}

export function shouldSuppressAutomatedSend(input: SuppressionInput): boolean {
  return evaluateAutomatedSuppression(input).suppressed;
}
