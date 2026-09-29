import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";
import { reportError } from "@/lib/errors/report";

import { delayToDate } from "./delays";
import { enrollLead, type EnrollmentOutcome } from "./enrollment";

export type DripResult = {
  propertyId: string;
  status: "enrolled" | "skipped" | "failed";
  reason: string;
};

export function enrollmentReason(outcome: EnrollmentOutcome): string {
  switch (outcome.status) {
    case "enrolled": return "Enrolled";
    case "duplicate_active": return "Already in this drip";
    case "no_phone": return "Lead has no phone number.";
    case "landline_phone": return "Lead only has a landline.";
    case "no_consent": return "Contact has opted out of SMS.";
    case "suppressed": return outcome.message;
    case "sequence_not_found": return "Drip not found.";
    case "sequence_inactive": return "Drip is inactive or archived.";
    case "property_not_found": return "Lead not found.";
    case "no_steps": return "Drip has no steps.";
    case "failed": return "Could not enroll this lead.";
  }
}

export async function startFollowUpDrip(
  client: SupabaseClient<Database>,
  input: { propertyIds: string[]; sequenceId: string; userId: string },
): Promise<{ results: DripResult[] }> {
  const results: DripResult[] = [];
  for (const propertyId of input.propertyIds) {
    try {
      const outcome = await enrollLead(client, {
        propertyId,
        sequenceId: input.sequenceId,
        enrolledByUserId: input.userId,
      });
      results.push({
        propertyId,
        status: outcome.status === "enrolled" ? "enrolled"
          : ["duplicate_active", "no_phone", "landline_phone", "no_consent", "suppressed"].includes(outcome.status)
            ? "skipped" : "failed",
        reason: enrollmentReason(outcome),
      });
    } catch (error) {
      reportError(error, { tags: { surface: "start_follow_up_drip" }, extra: { propertyId, sequenceId: input.sequenceId } });
      results.push({ propertyId, status: "failed", reason: "Could not enroll this lead." });
    }
  }
  return { results };
}

export function previewFirstSend(
  delayMinutes: number,
  timeZone: string,
  now = new Date(),
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(delayToDate(delayMinutes, now));
}
