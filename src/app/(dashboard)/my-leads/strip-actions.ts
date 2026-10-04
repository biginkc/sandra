"use server";

import { reportError } from "@/lib/errors/report";
import {
  getCallNext,
  getTriage,
  setCallNextOverride,
  STRIP_OVERRIDE_ACTIONS,
  type CallNextSnapshot,
  type StripOverrideAction,
  type TriageCursor,
  type TriageSnapshot,
} from "@/lib/my-leads/call-next";
import { MyLeadsReadError } from "@/lib/my-leads/queries";

type Failure = { ok: false; message: string };

function reportStripFailure(operation: string, error: unknown) {
  reportError(error instanceof Error ? error : new Error(`${operation} failed`), {
    errorClass: "database",
    tags: { surface: "database", operation },
  });
}

function failureMessage(error: unknown, fallback: string): string {
  return error instanceof MyLeadsReadError ? error.message : fallback;
}

/** The strip alone. `snapshot: null` means the strip is off for this org. */
export async function loadCallNext(
  memberId: string,
): Promise<{ ok: true; strip: CallNextSnapshot | null } | Failure> {
  try {
    return { ok: true, strip: await getCallNext({ memberId }) };
  } catch (error) {
    reportStripFailure("my_leads_call_next", error);
    return { ok: false, message: failureMessage(error, "The Call next strip could not load.") };
  }
}

export async function loadTriage(
  memberId: string,
  cursor?: TriageCursor | null,
): Promise<{ ok: true; triage: TriageSnapshot | null } | Failure> {
  try {
    return { ok: true, triage: await getTriage({ memberId, cursor }) };
  } catch (error) {
    reportStripFailure("my_leads_triage", error);
    return { ok: false, message: failureMessage(error, "The triage list could not load.") };
  }
}

/** Call today / Not today / clear. The action is checked before any RPC. */
export async function setStripOverride(input: {
  memberId: string;
  propertyId: string;
  action: StripOverrideAction;
}): Promise<{ ok: true; until: string | null } | Failure> {
  if (!(STRIP_OVERRIDE_ACTIONS as readonly string[]).includes(input.action))
    return { ok: false, message: "That action is not available." };
  try {
    const { until } = await setCallNextOverride(input);
    return { ok: true, until };
  } catch (error) {
    reportStripFailure("my_leads_strip_override", error);
    return { ok: false, message: failureMessage(error, "The change could not be saved. Please retry.") };
  }
}
