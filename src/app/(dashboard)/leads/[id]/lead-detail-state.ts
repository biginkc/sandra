import type { ConsentState } from "@/lib/messaging/consent";
import type { PhoneLineType } from "@/lib/messaging/line-type";

export type LeadSmsReadState = {
  hasContact: boolean;
  hasUsablePhone: boolean;
  consentState: ConsentState | null;
  contactSmsOptedOut: boolean;
  propertySmsOptedOut: boolean;
  phoneSuppressed: boolean | null;
  outreachDispo: string | null;
  phoneLineType: PhoneLineType | null;
};

export type LeadSmsPresentation = {
  consentLabel: string;
  consentDetail: string;
  smsRestricted: boolean;
  readFailed: boolean;
};

/**
 * Translate the existing consent event log, contact opt-out bit, and durable
 * phone suppression registry into operator-facing copy. A contact-level
 * do-not-contact flag is deliberately not accepted here: it is a separate
 * restriction and must never be presented as either an SMS opt-out or the
 * property's permanent DNC lock.
 */
export function deriveLeadSmsPresentation(
  state: LeadSmsReadState,
): LeadSmsPresentation {
  if (!state.hasContact) {
    return {
      consentLabel: "No contact linked",
      consentDetail: "Link a homeowner before checking SMS consent.",
      smsRestricted: false,
      readFailed: false,
    };
  }

  const readFailed =
    state.consentState === null || state.phoneSuppressed === null;
  const actualOptOut =
    state.contactSmsOptedOut ||
    state.propertySmsOptedOut ||
    state.phoneSuppressed === true ||
    state.consentState === "opted_out";

  if (actualOptOut) {
    return {
      consentLabel: "Opted out",
      consentDetail:
        "SMS is disabled. Calls, notes, and tasks remain available. This is not a permanent DNC.",
      smsRestricted: true,
      readFailed,
    };
  }

  if (
    state.outreachDispo === "wrong_number" ||
    state.outreachDispo === "bad_number"
  ) {
    return {
      consentLabel: "Number marked wrong",
      consentDetail:
        "SMS is disabled for this property disposition. Correct the phone record before texting.",
      smsRestricted: true,
      readFailed,
    };
  }

  if (!state.hasUsablePhone) {
    const landlineOnly = state.phoneLineType === "landline";
    return {
      consentLabel: landlineOnly ? "Landline only" : "No usable phone",
      consentDetail: landlineOnly
        ? "SMS cannot be delivered to the selected landline. Call or mail instead."
        : "SMS is unavailable until a textable number is linked.",
      smsRestricted: true,
      readFailed,
    };
  }

  if (state.consentState === null || state.phoneSuppressed === null) {
    return {
      consentLabel: "Could not verify",
      consentDetail:
        "Consent or phone-restriction data did not load. Retry before relying on this status.",
      // Fail closed until every authoritative source is readable. This is
      // an availability restriction, not a claim that the contact opted out.
      smsRestricted: true,
      readFailed: true,
    };
  }

  switch (state.consentState) {
    case "can_send_marketing":
      return {
        consentLabel: "OK to text",
        consentDetail: "Written marketing consent is on file.",
        smsRestricted: false,
        readFailed: false,
      };
    case "can_send_informational_only":
      return {
        consentLabel: "Informational only",
        consentDetail: "Marketing SMS still requires written consent.",
        smsRestricted: false,
        readFailed: false,
      };
    case "no_consent":
      return {
        consentLabel: "No consent on file",
        consentDetail: "Capture consent before sending marketing SMS.",
        smsRestricted: false,
        readFailed: false,
      };
    case "opted_out":
      // Covered by smsRestricted above. Keeping the exhaustive case makes a
      // future ConsentState addition fail visibly during typecheck.
      return {
        consentLabel: "Opted out",
        consentDetail:
          "SMS is disabled. Calls, notes, and tasks remain available. This is not a permanent DNC.",
        smsRestricted: true,
        readFailed: false,
      };
  }
}
