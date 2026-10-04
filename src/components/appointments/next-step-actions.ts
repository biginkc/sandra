"use server";

import { err, ok, type Result } from "@/lib/errors/result";
import { schemaReady } from "@/lib/my-leads/schema-ready";
import { createNextStep } from "@/lib/next-steps";
import { wallTimeToUtc } from "@/lib/time/zoned";

import {
  bookAppointment,
  type BookAppointmentResult,
} from "./book-appointment-action";

export type CreateNextStepActionInput = {
  /** Property this next step links to, if any. */
  propertyId?: string;
  /** Contact this next step links to, if any, independent of property. */
  contactId?: string;
  assigneeId: string;
  /** YYYY-MM-DD wall-clock date in `timeZone`. */
  date: string;
  /** HH:mm wall-clock time in `timeZone`. */
  time: string;
  /** The assignee's authoritative zone (from `getMemberTimezone`). */
  timeZone: string;
  /** Default "phone". A phone appointment is always 15 minutes. */
  mode?: "phone" | "in_person";
  /** In-person only. */
  durationMinutes?: number;
  location?: string;
  title: string;
  note?: string;
  /** One UUID per popover open, reused across retries of the same submit. */
  idempotencyKey?: string;
};

/**
 * "use server" wrapper over `createNextStep` for client components (they cannot import the lib
 * directly). It takes the same wall-clock fields the booking popover already collects and
 * converts them server-side. Until `schemaReady('next_step_write')` it runs today's booking
 * path unchanged (`bookAppointment`, with the duration the form showed), so the window between
 * a deploy and its migration cannot break scheduling. The result keeps the booking shape.
 */
export async function createNextStepAction(
  input: CreateNextStepActionInput,
): Promise<Result<BookAppointmentResult>> {
  const mode = input.mode ?? "phone";
  const durationMinutes = mode === "phone" ? 15 : input.durationMinutes;

  if (!(await schemaReady("next_step_write"))) {
    return bookAppointment({
      propertyId: input.propertyId,
      contactId: input.contactId,
      assigneeId: input.assigneeId,
      date: input.date,
      time: input.time,
      timeZone: input.timeZone,
      durationMinutes: durationMinutes ?? 30,
      title: input.title,
      note: input.note,
      idempotencyKey: input.idempotencyKey,
    });
  }

  const converted = wallTimeToUtc({
    date: input.date,
    time: input.time,
    timeZone: input.timeZone,
  });
  if (!converted.ok) {
    return err({
      code:
        converted.reason === "nonexistent" ? "TIME_NONEXISTENT" : "TIME_INVALID",
      message:
        converted.reason === "nonexistent"
          ? "That time doesn't exist in this timezone because of a daylight-saving change — pick another."
          : "Choose a valid date and time.",
    });
  }
  const created = await createNextStep({
    kind: "appointment",
    mode,
    assigneeId: input.assigneeId,
    title: input.title,
    dueAt: converted.utc.toISOString(),
    propertyId: input.propertyId,
    contactId: input.contactId,
    durationMinutes: mode === "in_person" ? durationMinutes : undefined,
    location: mode === "in_person" ? input.location : undefined,
    note: input.note,
    idempotencyKey: input.idempotencyKey,
    origin: "app",
  });
  if (!created.ok) return created;
  return ok({
    taskId: created.data.taskId,
    alreadyQualified: created.data.alreadyQualified,
    chainId: created.data.calendarChainId ?? "",
    duplicate: created.data.duplicate,
  });
}
