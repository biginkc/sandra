import type { ConsentState } from "./consent";

export const SUPPRESSED_DISPOS = new Set([
  "wrong_number",
  "bad_number",
  "dnc",
  "opted_out",
] as const);

export type SuppressedDispo = typeof SUPPRESSED_DISPOS extends ReadonlySet<infer T>
  ? T
  : never;

export type SuppressionInput = {
  outreachDispo?: string | null;
  consentState?: ConsentState | null;
  smsOptedOut?: boolean | null;
};

export type SuppressionDecision =
  | {
      suppressed: false;
    }
  | {
      suppressed: true;
      reason: string;
      source: "outreach_dispo" | "consent_state" | "sms_opted_out";
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
