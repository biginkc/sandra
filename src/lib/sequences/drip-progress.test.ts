import { describe, expect, it, vi } from "vitest";
import { dripStatus, pauseReasonText } from "./drip-status";
import { listDripProgress } from "./drip-progress";

const rows = {
  sequence_enrollments: [
    { id: "e1", property_id: "p1", sequence_id: "s1", status: "paused", pause_reason: "inbound_reply", current_step_index: 1, next_run_at: null, enrolled_at: "2026-09-01", completed_at: null },
    { id: "e2", property_id: "p2", sequence_id: "s1", status: "completed", pause_reason: null, current_step_index: 2, next_run_at: null, enrolled_at: "2026-09-01", completed_at: "2026-09-03" },
    { id: "e3", property_id: "p3", sequence_id: "s1", status: "completed", pause_reason: null, current_step_index: 2, next_run_at: null, enrolled_at: "2026-09-01", completed_at: "2026-09-03" },
  ],
  sequences: [{ id: "s1", name: "Follow up" }],
  sequence_steps: [{ id: "st1", sequence_id: "s1", step_index: 0, action_type: "send_sms", delay_after_previous_minutes: 0 }, { id: "st2", sequence_id: "s1", step_index: 1, action_type: "send_sms", delay_after_previous_minutes: 30 }],
  sequence_step_runs: [
    { enrollment_id: "e1", message_id: "m1", run_at: "2026-09-02T10:00:00Z" },
    { enrollment_id: "e2", message_id: "m2", run_at: "2026-09-02T11:00:00Z" },
    { enrollment_id: "e3", message_id: "m3", run_at: "2026-09-02T11:00:00Z" },
  ],
  messages: [{ id: "m1", property_id: "p1", direction: "outbound", body: "Hello first lead", created_at: "2026-09-02T10:00:00Z", sent_at: "2026-09-02T10:00:00Z" }, { id: "m2", property_id: "p2", direction: "outbound", body: "Hello second lead", created_at: "2026-09-02T11:00:00Z", sent_at: "2026-09-02T11:00:00Z" }, { id: "m3", property_id: "p3", direction: "outbound", body: "Hello third lead", created_at: "2026-09-02T11:00:00Z", sent_at: "2026-09-02T11:00:00Z" }, { id: "m4", property_id: "p3", direction: "inbound", body: "Thanks", created_at: "2026-09-02T12:00:00Z", sent_at: null }],
  lead_events: [{ property_id: "p2", event_type: "sequence_canceled", payload: { enrollment_id: "e2" } }],
};

function client(overrides: Partial<typeof rows> = {}) {
  const fixture = { ...rows, ...overrides };
  const calls: Array<{ table: string; ids: string[] }> = [];
  return { calls, from: vi.fn((table: keyof typeof rows) => ({
    select: () => ({ in: (column: string, ids: string[]) => {
      calls.push({ table, ids });
      const key = table === "sequence_enrollments" || table === "lead_events" ? "property_id" : table === "sequences" ? "id" : table === "sequence_steps" ? "sequence_id" : table === "sequence_step_runs" ? "enrollment_id" : column;
      let data: Array<Record<string, unknown>> = fixture[table].filter((row) => ids.includes(String(row[key as keyof typeof row])));
      const result = () => ({ data, error: null });
      const query = { then: (resolve: (value: ReturnType<typeof result>) => void) => Promise.resolve(result()).then(resolve),
        order: () => query,
        eq: (column: string, value: string) => { data = data.filter((row) => row[column] === value); return query; },
        gt: (column: string, value: string) => { data = data.filter((row) => String(row[column]) > value); return query; },
        range: (start: number, end: number) => Promise.resolve({ data: data.slice(start, end + 1), error: null }) };
      return query;
    } }),
  })) };
}

describe("drip status", () => {
  it.each([
    ["active", null, false, "Waiting"],
    ["paused", "inbound_reply", false, "Replied"],
    ["paused", "rep_sms_human_takeover", false, "Replied"],
    ["paused", "provider_failed", false, "Couldn't send"],
    ["paused", "reconciliation_required", false, "Couldn't send"],
    ["paused", "step_misconfigured", false, "Couldn't send"],
    ["paused", "no_phone", false, "Couldn't send"],
    ["opted_out", "consent_revoked", false, "Stopped"],
    ["completed", null, true, "Stopped"],
    ["completed", null, false, "Finished, no reply"],
  ])("maps %s / %s / canceled=%s to %s", (status, reason, canceled, expected) => {
    expect(dripStatus(status, reason, canceled)).toBe(expected);
  });
  it("renders manual and operational reasons in plain English", () => {
    expect(pauseReasonText("manual")).toMatch(/paused by/i);
    expect(pauseReasonText("template_missing")).toMatch(/template/i);
    expect(pauseReasonText("reconciliation_required")).toMatch(/delivery/i);
    expect(pauseReasonText("step_misconfigured")).toMatch(/step/i);
    expect(pauseReasonText("no_phone")).toMatch(/phone/i);
    expect(pauseReasonText("not_interested")).toMatch(/not interested/i);
  });
});

describe("listDripProgress", () => {
  it("prefers an older paused enrollment to a newer completed enrollment", async () => {
    const stub = client({ sequence_enrollments: [
      rows.sequence_enrollments[0],
      { ...rows.sequence_enrollments[1], id: "new-completed", property_id: "p1", enrolled_at: "2026-09-10" },
    ] });
    expect(await listDripProgress(stub as never, ["p1"]))
      .toMatchObject([{ enrollmentId: "e1", status: "Replied" }]);
  });
  it("prefers a live enrollment to a completed one regardless of row order", async () => {
    const stub = client({ sequence_enrollments: [
      { ...rows.sequence_enrollments[1], id: "completed-first", property_id: "p1", enrolled_at: "2026-09-10" },
      { ...rows.sequence_enrollments[0], id: "active-second", status: "active" },
    ] });
    expect(await listDripProgress(stub as never, ["p1"]))
      .toMatchObject([{ enrollmentId: "active-second", status: "Waiting" }]);
  });
  it("reports the next step with the inbox's one-based index", async () => {
    const stub = client({ sequence_enrollments: [
      { ...rows.sequence_enrollments[0], current_step_index: 0, status: "active" },
    ] });
    expect(await listDripProgress(stub as never, ["p1"]))
      .toMatchObject([{ step: 1, totalSteps: 2 }]);
    expect(await listDripProgress(client() as never, ["p1"]))
      .toMatchObject([{ step: 2, totalSteps: 2 }]);
    const mixed = client({
      sequence_steps: [
        { id: "status-1", sequence_id: "s1", step_index: 0, action_type: "change_status", delay_after_previous_minutes: 0 },
        { id: "sms-2", sequence_id: "s1", step_index: 1, action_type: "send_sms", delay_after_previous_minutes: 30 },
        { id: "status-3", sequence_id: "s1", step_index: 2, action_type: "change_status", delay_after_previous_minutes: 30 },
      ],
    });
    expect(await listDripProgress(mixed as never, ["p1"]))
      .toMatchObject([{ step: 2, totalSteps: 3 }]);
  });
  it("links sent messages and cancellation to the right enrollment", async () => {
    const result = await listDripProgress(client() as never, ["p1", "p2"]);
    expect(result).toMatchObject([
      { propertyId: "p1", sequenceName: "Follow up", step: 2, totalSteps: 2, status: "Replied", lastText: { preview: "Hello first lead" } },
      { propertyId: "p2", status: "Stopped", lastText: { preview: "Hello second lead" } },
    ]);
  });
  it("calls a completed drip Replied when an inbound arrives after its last send", async () => {
    expect(await listDripProgress(client() as never, ["p3"]))
      .toMatchObject([{ propertyId: "p3", status: "Replied", lastText: { preview: "Hello third lead" } }]);
  });
  it("keeps every query batch at or below 100", async () => {
    const stub = client();
    await listDripProgress(stub as never, Array.from({ length: 205 }, (_, i) => `p${i}`));
    expect(stub.calls.length).toBeGreaterThan(2);
    expect(stub.calls.every((call) => call.ids.length <= 100)).toBe(true);
  });
});
