import { describe, expect, it, vi } from "vitest";

import { sendSmsToContact } from "@/lib/messaging/send";

import { processEnrollmentTick } from "./tick";

vi.mock("@/lib/messaging/send", () => ({
  sendSmsToContact: vi.fn(),
}));

/**
 * Minimal chainable/thenable query-builder stub — every chain method
 * returns itself, and the object resolves (via `.then` or `.maybeSingle()`)
 * to a fixed `{ data, error }`. Covers exactly the two round-trips
 * `processEnrollmentTick` makes before its outreach-dispo pause check:
 * `sequence_steps` (current step) and `properties` (status/dispo). The
 * pause branch itself only awaits a `sequence_enrollments` update without
 * reading the result, so any resolved value there is fine.
 */
function makeQueryResult(data: unknown, error: unknown = null) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder.select = chain;
  builder.eq = chain;
  builder.update = chain;
  builder.insert = chain;
  builder.order = chain;
  builder.limit = chain;
  builder.maybeSingle = () => Promise.resolve({ data, error });
  builder.single = () => Promise.resolve({ data, error });
  builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
    resolve({ data, error });
  return builder;
}

const STEP_ROW = {
  id: "step-1",
  step_index: 0,
  action_type: "send_sms",
  template_body: "hi",
  template_id: null,
  template_category: null,
  target_status: null,
  delay_after_previous_minutes: 60,
};

const BASE_ENROLLMENT = {
  id: "enrollment-1",
  org_id: "org-1",
  sequence_id: "seq-1",
  property_id: "property-1",
  contact_id: "contact-1",
  current_step_index: 0,
  enrolled_by_user_id: null,
  status: "active",
};

function makeClient(propertyRow: {
  status: string;
  state: string;
  address: string;
  outreach_dispo: string | null;
  is_dnc_locked?: boolean;
}) {
  const from = vi.fn((table: string) => {
    if (table === "sequence_steps") return makeQueryResult(STEP_ROW);
    if (table === "properties") return makeQueryResult(propertyRow);
    if (table === "sequence_enrollments") return makeQueryResult(null);
    // Not reached when the pause check fires first; when it doesn't (the
    // "does not pause" test), stop cleanly here rather than going deeper
    // into the send_sms path this suite isn't exercising.
    if (table === "sequence_step_runs") {
      return makeQueryResult(null, { message: "not exercised by this suite" });
    }
    throw new Error(`Unexpected table in test: ${table}`);
  });
  return { from } as never;
}

describe("processEnrollmentTick — outbound suppression boundary", () => {
  it("pauses before claiming or sending when the property is permanently locked", async () => {
    let capturedUpdate: unknown;
    const from = vi.fn((table: string) => {
      if (table === "sequence_steps") return makeQueryResult(STEP_ROW);
      if (table === "properties")
        return makeQueryResult({
          status: "interested",
          state: "MO",
          address: "123 Main St",
          outreach_dispo: null,
          is_dnc_locked: true,
        });
      if (table === "sequence_enrollments") {
        const builder: Record<string, unknown> = {};
        builder.update = (payload: unknown) => {
          capturedUpdate = payload;
          return builder;
        };
        builder.eq = () => builder;
        builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
          resolve({ data: null, error: null });
        return builder;
      }
      throw new Error(`Unexpected table: ${table}`);
    });
    const client = { from } as never;

    const outcome = await processEnrollmentTick(client, BASE_ENROLLMENT);

    expect(outcome).toEqual({
      status: "paused",
      enrollmentId: "enrollment-1",
      reason: "dnc",
    });
    expect(capturedUpdate).toMatchObject({
      status: "opted_out",
      pause_reason: "dnc",
      next_run_at: null,
    });
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("reports a failed permanent opt-out instead of claiming the lead was paused", async () => {
    const from = vi.fn((table: string) => {
      if (table === "sequence_steps") return makeQueryResult(STEP_ROW);
      if (table === "properties")
        return makeQueryResult({
          status: "interested",
          state: "MO",
          address: "123 Main St",
          outreach_dispo: null,
          is_dnc_locked: true,
        });
      if (table === "sequence_enrollments")
        return makeQueryResult(null, { message: "write rejected" });
      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(
      processEnrollmentTick({ from } as never, BASE_ENROLLMENT),
    ).resolves.toEqual({
      status: "failed",
      enrollmentId: "enrollment-1",
      message: "write rejected",
    });
    expect(sendSmsToContact).not.toHaveBeenCalled();
  });

  it("pauses (resumably) an enrollment when the property was just booked", async () => {
    const client = makeClient({
      status: "lead",
      state: "MO",
      address: "123 Main St",
      outreach_dispo: "booked_appointment",
    });

    const outcome = await processEnrollmentTick(client, BASE_ENROLLMENT);

    expect(outcome).toEqual({
      status: "paused",
      enrollmentId: "enrollment-1",
      reason: "booked_appointment",
    });
  });

  it.each(["nurture", "callback_requested"])(
    "also pauses on the other human-owned dispo %s",
    async (outreach_dispo) => {
      const client = makeClient({
        status: "lead",
        state: "MO",
        address: "123 Main St",
        outreach_dispo,
      });

      const outcome = await processEnrollmentTick(client, BASE_ENROLLMENT);

      expect(outcome).toEqual({
        status: "paused",
        enrollmentId: "enrollment-1",
        reason: outreach_dispo,
      });
    },
  );

  it("still permanently opts out on dnc (regression: SUPPRESSED_DISPOS path unaffected)", async () => {
    const client = makeClient({
      status: "lead",
      state: "MO",
      address: "123 Main St",
      outreach_dispo: "dnc",
    });

    let capturedUpdate: unknown;
    const from = vi.fn((table: string) => {
      if (table === "sequence_steps") return makeQueryResult(STEP_ROW);
      if (table === "properties")
        return makeQueryResult({
          status: "lead",
          state: "MO",
          address: "123 Main St",
          outreach_dispo: "dnc",
        });
      if (table === "sequence_enrollments") {
        const builder: Record<string, unknown> = {};
        builder.update = (payload: unknown) => {
          capturedUpdate = payload;
          return builder;
        };
        builder.eq = () => builder;
        builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
          resolve({ data: null, error: null });
        return builder;
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const outcome = await processEnrollmentTick({ from } as never, BASE_ENROLLMENT);

    expect(outcome).toEqual({
      status: "paused",
      enrollmentId: "enrollment-1",
      reason: "dnc",
    });
    expect(capturedUpdate).toMatchObject({
      status: "opted_out",
      pause_reason: "dnc",
      next_run_at: null,
    });
  });

  it("does not pause on a non-suppressing dispo", async () => {
    const client = makeClient({
      status: "lead",
      state: "MO",
      address: "123 Main St",
      outreach_dispo: "not_interested",
    });

    const outcome = await processEnrollmentTick(client, BASE_ENROLLMENT);

    expect(outcome.status).not.toBe("paused");
  });
});

describe("processEnrollmentTick — send_sms race: booking lands after the early gate", () => {
  it("pauses (resumably) without advancing when send.ts's fresh check catches a booking that landed after the early gate passed", async () => {
    // The early gate (step 2) sees a clean dispo and lets the tick proceed
    // into send_sms. The flip to booked_appointment is simulated as having
    // happened inside send.ts's own immediately-before-provider-call
    // re-check — represented here by mocking sendSmsToContact to return
    // exactly what that fresh check now returns instead of "sent".
    const cleanPropertyRow = {
      status: "lead",
      state: "MO",
      address: "123 Main St",
      city: "Kansas City",
      zip: "64111",
      market: "KC",
      org_id: null,
      outreach_dispo: null,
    };
    const from = vi.fn((table: string) => {
      if (table === "sequence_steps") return makeQueryResult(STEP_ROW);
      if (table === "properties") return makeQueryResult(cleanPropertyRow);
      if (table === "contacts") return makeQueryResult({ first_name: "Sam", last_name: "Test" });
      if (table === "sequences") return makeQueryResult({ append_opt_out: true });
      if (table === "sequence_step_runs") {
        const builder: Record<string, unknown> = {};
        builder.insert = () => builder;
        builder.update = () => builder;
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.single = () => Promise.resolve({ data: { id: "run-1" }, error: null });
        builder.then = (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
          resolve({ data: null, error: null });
        return builder;
      }
      if (table === "sequence_enrollments") return makeQueryResult(null);
      throw new Error(`Unexpected table in test: ${table}`);
    });
    const client = { from } as never;

    vi.mocked(sendSmsToContact).mockResolvedValue({
      status: "blocked_automated_suppressed",
      messageId: "msg-race-1",
      reason:
        "Property has a human-owned disposition: booked_appointment. Automated sends are suppressed.",
      source: "human_owned_dispo",
      outreachDispo: "booked_appointment",
      consentState: null,
    });

    const outcome = await processEnrollmentTick(client, BASE_ENROLLMENT);

    expect(outcome).toEqual({
      status: "paused",
      enrollmentId: "enrollment-1",
      reason: "terminal_dispo",
    });
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledWith(
      client,
      expect.objectContaining({ origin: "automated" }),
    );
  });
});

describe("processEnrollmentTick — change_status DNC race", () => {
  it("does not report a status change when a concurrent DNC lock wins", async () => {
    let propertyCall = 0;
    let runCall = 0;
    let enrollmentUpdate: unknown;
    const changeStep = {
      ...STEP_ROW,
      action_type: "change_status",
      target_status: "contacted",
    };
    const from = vi.fn((table: string) => {
      if (table === "sequence_steps") return makeQueryResult(changeStep);
      if (table === "properties") {
        propertyCall += 1;
        if (propertyCall === 1) {
          return makeQueryResult({
            status: "new_lead",
            state: "MO",
            address: "123 Main St",
            outreach_dispo: null,
            is_dnc_locked: false,
          });
        }
        if (propertyCall === 2) return makeQueryResult(null);
        return makeQueryResult({ is_dnc_locked: true });
      }
      if (table === "sequence_step_runs") {
        runCall += 1;
        return makeQueryResult(runCall === 1 ? { id: "run-1" } : null);
      }
      if (table === "sequence_enrollments") {
        const builder = makeQueryResult(null) as Record<string, unknown>;
        builder.update = (payload: unknown) => {
          enrollmentUpdate = payload;
          return builder;
        };
        return builder;
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    const outcome = await processEnrollmentTick(
      { from } as never,
      BASE_ENROLLMENT,
    );

    expect(outcome).toEqual({
      status: "paused",
      enrollmentId: "enrollment-1",
      reason: "dnc",
    });
    expect(enrollmentUpdate).toMatchObject({
      status: "opted_out",
      pause_reason: "dnc",
    });
  });

  it("reports failure when stopping the enrollment after the race fails", async () => {
    let propertyCall = 0;
    let runCall = 0;
    const changeStep = {
      ...STEP_ROW,
      action_type: "change_status",
      target_status: "contacted",
    };
    const from = vi.fn((table: string) => {
      if (table === "sequence_steps") return makeQueryResult(changeStep);
      if (table === "properties") {
        propertyCall += 1;
        if (propertyCall === 1) {
          return makeQueryResult({
            status: "new_lead",
            state: "MO",
            address: "123 Main St",
            outreach_dispo: null,
            is_dnc_locked: false,
          });
        }
        if (propertyCall === 2) return makeQueryResult(null);
        return makeQueryResult({ is_dnc_locked: true });
      }
      if (table === "sequence_step_runs") {
        runCall += 1;
        return makeQueryResult(runCall === 1 ? { id: "run-1" } : null);
      }
      if (table === "sequence_enrollments") {
        return makeQueryResult(null, { message: "enrollment write failed" });
      }
      throw new Error(`Unexpected table: ${table}`);
    });

    await expect(
      processEnrollmentTick({ from } as never, BASE_ENROLLMENT),
    ).resolves.toEqual({
      status: "failed",
      enrollmentId: "enrollment-1",
      message: "enrollment write failed",
    });
  });
});
