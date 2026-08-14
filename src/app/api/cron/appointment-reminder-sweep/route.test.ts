import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverAppointmentReminder: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/notifications/reminders", () => ({
  deliverAppointmentReminder: mocks.deliverAppointmentReminder,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import { runAppointmentReminderSweep } from "./route";

type RawRow = {
  delivery_id: string;
  task_id: string;
  org_id: string;
  channel: "bell" | "slack" | "sms";
  attempts: number;
  task_title: string;
  task_due_at: string;
  task_end_at: string | null;
  assignee_id: string;
  assignee_timezone: string;
  assignee_reminder_phone: string | null;
};

function rawRow(id: string, overrides: Partial<RawRow> = {}): RawRow {
  return {
    delivery_id: id,
    task_id: `task-${id}`,
    org_id: "org-1",
    channel: "bell",
    attempts: 0,
    task_title: "Walkthrough",
    task_due_at: "2026-09-01T15:00:00.000Z",
    task_end_at: "2026-09-01T15:30:00.000Z",
    assignee_id: "assignee-1",
    assignee_timezone: "America/Chicago",
    assignee_reminder_phone: null,
    ...overrides,
  };
}

/** Fake Supabase client: `rpc` special-cases the two claim functions. */
function fakeSupabase(claimed: RawRow[], retried: RawRow[] = []) {
  const rpc = vi.fn(async (fn: string) => {
    if (fn === "fn_claim_appointment_reminders") {
      return { data: claimed, error: null };
    }
    if (fn === "fn_claim_reminder_retries") {
      return { data: retried, error: null };
    }
    return { data: [], error: null };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { rpc } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runAppointmentReminderSweep", () => {
  it("claims both the primary window and retries, then delivers every row", async () => {
    const supabase = fakeSupabase([rawRow("a"), rawRow("b")], [rawRow("c")]);
    mocks.deliverAppointmentReminder.mockResolvedValue({
      status: "sent",
      deliveryId: "x",
      channel: "bell",
    });

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(supabase.rpc).toHaveBeenCalledWith("fn_claim_appointment_reminders");
    expect(supabase.rpc).toHaveBeenCalledWith("fn_claim_reminder_retries", { p_limit: 50 });
    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledTimes(3);
    expect(summary.claimed).toBe(2);
    expect(summary.retried).toBe(1);
    expect(summary.processed).toBe(3);
  });

  it("maps the raw RPC row shape to the worker's camelCase row before delivering", async () => {
    const supabase = fakeSupabase([
      rawRow("a", { assignee_reminder_phone: "+18165551234", channel: "sms" }),
    ]);
    mocks.deliverAppointmentReminder.mockResolvedValue({
      status: "sent",
      deliveryId: "a",
      channel: "sms",
    });

    await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(mocks.deliverAppointmentReminder).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        deliveryId: "a",
        taskId: "task-a",
        orgId: "org-1",
        channel: "sms",
        assigneeReminderPhone: "+18165551234",
      }),
    );
  });

  it("tallies outcomes by status and reports failed deliveries", async () => {
    const supabase = fakeSupabase([rawRow("a"), rawRow("b")]);
    mocks.deliverAppointmentReminder
      .mockResolvedValueOnce({ status: "sent", deliveryId: "a", channel: "bell" })
      .mockResolvedValueOnce({ status: "failed", deliveryId: "b", channel: "bell", error: "boom" });

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(summary.outcomes.sent).toBe(1);
    expect(summary.outcomes.failed).toBe(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "cron_appointment_reminder_sweep_outcome" } }),
    );
  });

  it("a rejecting delivery doesn't prevent the next row from being processed", async () => {
    const supabase = fakeSupabase([rawRow("a"), rawRow("b")]);
    mocks.deliverAppointmentReminder
      .mockRejectedValueOnce(new Error("transport blew up"))
      .mockResolvedValueOnce({ status: "sent", deliveryId: "b", channel: "bell" });

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(summary.processed).toBe(2);
    expect(summary.outcomes.sweep_level_error).toBe(1);
    expect(summary.outcomes.sent).toBe(1);
    expect(mocks.reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "cron_appointment_reminder_sweep_unhandled" } }),
    );
  });

  it("stops processing once the budget is exhausted mid-sweep", async () => {
    const budgetMs = 1_000;
    const times = [0, 0, budgetMs + 1];
    let call = 0;
    vi.spyOn(Date, "now").mockImplementation(
      () => times[Math.min(call++, times.length - 1)],
    );

    const supabase = fakeSupabase([rawRow("a"), rawRow("b")]);
    mocks.deliverAppointmentReminder.mockResolvedValue({
      status: "sent",
      deliveryId: "a",
      channel: "bell",
    });

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs });

    expect(summary.processed).toBe(1);
    expect(summary.budgetExhausted).toBe(true);
  });

  it("throws if the primary claim RPC errors", async () => {
    const supabase = fakeSupabase([]);
    supabase.rpc = vi.fn(async (fn: string) =>
      fn === "fn_claim_appointment_reminders"
        ? { data: null, error: { message: "boom" } }
        : { data: [], error: null },
    );

    await expect(runAppointmentReminderSweep(supabase, { budgetMs: 60_000 })).rejects.toThrow(
      /fn_claim_appointment_reminders failed/,
    );
    expect(mocks.deliverAppointmentReminder).not.toHaveBeenCalled();
  });

  it("throws if the retry claim RPC errors", async () => {
    const supabase = fakeSupabase([]);
    supabase.rpc = vi.fn(async (fn: string) =>
      fn === "fn_claim_reminder_retries"
        ? { data: null, error: { message: "boom" } }
        : { data: [], error: null },
    );

    await expect(runAppointmentReminderSweep(supabase, { budgetMs: 60_000 })).rejects.toThrow(
      /fn_claim_reminder_retries failed/,
    );
  });

  it("returns zeros and does not call the delivery worker when nothing is claimed", async () => {
    const supabase = fakeSupabase([]);

    const summary = await runAppointmentReminderSweep(supabase, { budgetMs: 60_000 });

    expect(summary.claimed).toBe(0);
    expect(summary.retried).toBe(0);
    expect(summary.processed).toBe(0);
    expect(mocks.deliverAppointmentReminder).not.toHaveBeenCalled();
  });
});
