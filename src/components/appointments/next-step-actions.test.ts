import { beforeEach, describe, expect, it, vi } from "vitest";

const { schemaReady, createNextStep, bookAppointment } = vi.hoisted(() => ({
  schemaReady: vi.fn(),
  createNextStep: vi.fn(),
  bookAppointment: vi.fn(),
}));

vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady }));
vi.mock("@/lib/next-steps", () => ({ createNextStep }));
vi.mock("./book-appointment-action", () => ({ bookAppointment }));

import { createNextStepAction } from "./next-step-actions";

const base = {
  propertyId: "prop-1",
  contactId: "contact-1",
  assigneeId: "user-1",
  date: "2026-06-15",
  time: "14:00",
  timeZone: "America/Chicago",
  title: "Appointment — 1 Main",
  note: "n",
  idempotencyKey: "11111111-1111-4111-8111-111111111111",
};

describe("createNextStepAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs today's booking path unchanged until the schema is ready", async () => {
    schemaReady.mockResolvedValue(false);
    bookAppointment.mockResolvedValue({ ok: true, data: { taskId: "t1", alreadyQualified: false, chainId: "c1", duplicate: false } });
    const result = await createNextStepAction({ ...base, mode: "in_person", durationMinutes: 45 });
    expect(result.ok).toBe(true);
    expect(createNextStep).not.toHaveBeenCalled();
    expect(bookAppointment).toHaveBeenCalledWith(expect.objectContaining({ durationMinutes: 45, date: "2026-06-15", time: "14:00" }));
  });

  it("converts the wall time server-side and writes a phone next step (15 minutes, booking effects on)", async () => {
    schemaReady.mockResolvedValue(true);
    createNextStep.mockResolvedValue({ ok: true, data: { taskId: "t2", calendarChainId: "c2", alreadyQualified: false, duplicate: false } });
    const result = await createNextStepAction({ ...base, durationMinutes: 90, location: "ignored" });
    expect(result).toEqual({ ok: true, data: { taskId: "t2", alreadyQualified: false, chainId: "c2", duplicate: false } });
    expect(bookAppointment).not.toHaveBeenCalled();
    const arg = createNextStep.mock.calls[0]![0];
    expect(arg).toMatchObject({ kind: "appointment", mode: "phone", dueAt: "2026-06-15T19:00:00.000Z", origin: "app", idempotencyKey: base.idempotencyKey });
    expect(arg.durationMinutes).toBeUndefined();
    expect(arg.location).toBeUndefined();
    // Today's behavior kept: booking effects (drip pause, booked_appointment, prospect promotion).
    expect(arg.applyBookingEffects).toBe(true);
  });

  it("passes duration and location for an in-person appointment and refuses a DST-gap time", async () => {
    schemaReady.mockResolvedValue(true);
    createNextStep.mockResolvedValue({ ok: true, data: { taskId: "t3", calendarChainId: null, alreadyQualified: false, duplicate: true } });
    await createNextStepAction({ ...base, mode: "in_person", durationMinutes: 60, location: "12 Oak" });
    expect(createNextStep.mock.calls[0]![0]).toMatchObject({ mode: "in_person", durationMinutes: 60, location: "12 Oak" });
    createNextStep.mockClear();
    const gap = await createNextStepAction({ ...base, date: "2026-03-08", time: "02:30" });
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.error.code).toBe("TIME_NONEXISTENT");
    expect(createNextStep).not.toHaveBeenCalled();
  });
});
