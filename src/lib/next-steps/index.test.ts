import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void> | void>,
  assertNotTrainingTarget: vi.fn(),
  assertContactDncUnlocked: vi.fn(),
  assertPropertyDncUnlocked: vi.fn(),
  createAdminClient: vi.fn(() => ({ __admin: true })),
  createClient: vi.fn(),
  dispatchTaskAssigned: vi.fn(),
  dispatchTaskAssignedSlack: vi.fn(),
  dispatchTaskCalendarEvent: vi.fn(),
  kickCalendarMutationSync: vi.fn(),
  loadIntegrationPrefs: vi.fn(),
  pausePropertyEnrollments: vi.fn(),
  recordLeadEvents: vi.fn(),
  requireOrgMembership: vi.fn(),
  requireOrgMembershipByResource: vi.fn(),
  revalidatePath: vi.fn(),
  reportError: vi.fn(),
}));

vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: m.assertNotTrainingTarget }));
vi.mock("@/lib/supabase/server", () => ({ createClient: m.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: m.createAdminClient }));
vi.mock("@/lib/dnc/property-lock", () => ({
  assertContactDncUnlocked: m.assertContactDncUnlocked,
  assertPropertyDncUnlocked: m.assertPropertyDncUnlocked,
}));
vi.mock("@/lib/errors/report", () => ({ reportError: m.reportError }));
vi.mock("next/cache", () => ({ revalidatePath: m.revalidatePath }));
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void> | void) => {
    m.afterCallbacks.push(cb);
  },
}));
vi.mock("@/lib/integrations/prefs", () => ({ loadIntegrationPrefs: m.loadIntegrationPrefs }));
vi.mock("@/lib/integrations/slack/dispatch", () => ({
  dispatchTaskAssignedSlack: m.dispatchTaskAssignedSlack,
  dispatchTaskCalendarEvent: m.dispatchTaskCalendarEvent,
}));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchTaskAssigned: m.dispatchTaskAssigned }));
vi.mock("@/lib/sequences/enrollment", () => ({ pausePropertyEnrollments: m.pausePropertyEnrollments }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { QUALIFIED: "qualified" },
  recordLeadEvents: m.recordLeadEvents,
}));
vi.mock("@/lib/appointments/inline-sync-kick", () => ({
  kickCalendarMutationSync: m.kickCalendarMutationSync,
}));
vi.mock("@/lib/auth/require-org-membership", () => ({
  requireOrgMembership: m.requireOrgMembership,
  requireOrgMembershipByResource: m.requireOrgMembershipByResource,
}));

import { createNextStep } from "./index";

const DUE = "2026-10-10T15:00:00.000Z";

function rpcData(over: Record<string, unknown> = {}) {
  return {
    task_id: "task-1",
    calendar_chain_id: "chain-1",
    ledger_id: null,
    duplicate: false,
    converted: false,
    kind: "appointment",
    mode: "phone",
    related_property_id: "prop-1",
    contact_id: null,
    already_qualified: false,
    ...over,
  };
}

function supabaseWith(rpcResult: { data: unknown; error: unknown }, userId: string | null = "user-1") {
  const rpc = vi.fn().mockResolvedValue(rpcResult);
  const maybeSingle = vi.fn().mockResolvedValue({ data: { address: "1 Main St" }, error: null });
  const q: Record<string, unknown> = {};
  q.select = vi.fn(() => q);
  q.eq = vi.fn(() => q);
  q.maybeSingle = maybeSingle;
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: userId ? { id: userId } : null } }) },
    rpc,
    from: vi.fn(() => q),
  };
  m.createClient.mockResolvedValue(client);
  return client;
}

const BASE = { kind: "appointment" as const, assigneeId: "user-1", title: "Walk the house", dueAt: DUE, propertyId: "prop-1" };

beforeEach(() => {
  vi.clearAllMocks();
  m.afterCallbacks.length = 0;
  m.assertNotTrainingTarget.mockResolvedValue(undefined);
  m.assertContactDncUnlocked.mockResolvedValue({ ok: true, data: null });
  m.assertPropertyDncUnlocked.mockResolvedValue({ ok: true, data: null });
  m.requireOrgMembershipByResource.mockResolvedValue({ userId: "user-1", orgId: "org-1", role: "member", resourceId: "prop-1" });
  m.requireOrgMembership.mockResolvedValue({ userId: "user-1", orgId: "org-1", role: "member" });
  m.kickCalendarMutationSync.mockResolvedValue(undefined);
  m.loadIntegrationPrefs.mockResolvedValue({ slackEnabled: true, calendarEnabled: true, timezone: "America/Chicago" });
  m.pausePropertyEnrollments.mockResolvedValue({ paused: 0 });
  m.recordLeadEvents.mockResolvedValue(undefined);
});

describe("createNextStep", () => {
  it("phone path sends p_mode phone, no end or location, and enforces the window", async () => {
    const c = supabaseWith({ data: rpcData(), error: null });
    const r = await createNextStep(BASE);
    expect(r).toMatchObject({ ok: true, data: { taskId: "task-1", mode: "phone", ledgerId: null } });
    expect(c.rpc).toHaveBeenCalledWith("fn_create_next_step", {
      p_org: "org-1",
      p_actor: "user-1",
      p_assignee: "user-1",
      p_kind: "appointment",
      p_title: "Walk the house",
      p_due_at: DUE,
      p_property: "prop-1",
      p_contact: null,
      p_mode: "phone",
      p_end_at: null,
      p_location: null,
      p_description: null,
      p_source_key: null,
      p_idempotency_key: null,
      p_lead_next_action_key: null,
      p_origin: "app",
      p_enforce_window: true,
      p_apply_booking_effects: false,
    });
  });

  it("in_person requires a duration and sends the computed end", async () => {
    const c = supabaseWith({ data: rpcData({ mode: "in_person" }), error: null });
    const bad = await createNextStep({ ...BASE, mode: "in_person" });
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_DURATION" } });
    expect(c.rpc).not.toHaveBeenCalled();
    await createNextStep({ ...BASE, mode: "in_person", durationMinutes: 30, location: " 1 Main " });
    expect(c.rpc).toHaveBeenCalledWith(
      "fn_create_next_step",
      expect.objectContaining({ p_mode: "in_person", p_end_at: "2026-10-10T15:30:00.000Z", p_location: "1 Main" }),
    );
  });

  it("a task sends a null mode and the custom task type notification", async () => {
    const c = supabaseWith({ data: rpcData({ kind: "task" }), error: null });
    await createNextStep({ ...BASE, kind: "task", assigneeId: "user-2" });
    expect(c.rpc).toHaveBeenCalledWith("fn_create_next_step", expect.objectContaining({ p_kind: "task", p_mode: null }));
    await m.afterCallbacks[0]();
    expect(m.dispatchTaskAssigned).toHaveBeenCalledWith(c, expect.objectContaining({ taskType: "custom" }));
  });

  it("training and DNC blocks short-circuit before the RPC", async () => {
    const c = supabaseWith({ data: rpcData(), error: null });
    m.assertNotTrainingTarget.mockRejectedValueOnce(new Error("TRAINING_PROTECTED"));
    expect((await createNextStep(BASE)).ok).toBe(false);
    m.assertPropertyDncUnlocked.mockResolvedValueOnce({ ok: false, error: { code: "DNC_LOCKED", message: "locked" } });
    expect(await createNextStep(BASE)).toMatchObject({ ok: false, error: { code: "DNC_LOCKED" } });
    expect(c.rpc).not.toHaveBeenCalled();
  });

  it("a duplicate skips notifications", async () => {
    supabaseWith({ data: rpcData({ duplicate: true }), error: null });
    const r = await createNextStep({ ...BASE, assigneeId: "user-2", idempotencyKey: "k" });
    expect(r).toMatchObject({ ok: true, data: { duplicate: true } });
    expect(m.afterCallbacks).toHaveLength(0);
    expect(m.loadIntegrationPrefs).not.toHaveBeenCalled();
  });

  it("a ledger id triggers exactly one kick, and no direct calendar dispatch", async () => {
    supabaseWith({ data: rpcData({ ledger_id: "ledger-1", mode: "in_person" }), error: null });
    await createNextStep({ ...BASE, assigneeId: "user-2", mode: "in_person", durationMinutes: 30 });
    await m.afterCallbacks[0]();
    expect(m.kickCalendarMutationSync).toHaveBeenCalledTimes(1);
    expect(m.kickCalendarMutationSync).toHaveBeenCalledWith({ __admin: true }, "ledger-1");
    expect(m.dispatchTaskCalendarEvent).not.toHaveBeenCalled();
  });

  it("maps RPC errors to codes", async () => {
    for (const [error, code] of [
      [{ message: "FORBIDDEN", code: "42501" }, "FORBIDDEN"],
      [{ message: "DNC_LOCKED", code: "P0001" }, "DNC_LOCKED"],
      [{ message: "bad window", code: "22023" }, "INVALID_INPUT"],
      [{ message: "weird" }, "CREATE_NEXT_STEP_FAILED"],
    ] as const) {
      supabaseWith({ data: null, error });
      expect(await createNextStep(BASE)).toMatchObject({ ok: false, error: { code } });
    }
  });

  it("booking effects are off by default and on only when asked", async () => {
    supabaseWith({ data: rpcData(), error: null });
    await createNextStep(BASE);
    expect(m.recordLeadEvents).not.toHaveBeenCalled();
    expect(m.pausePropertyEnrollments).not.toHaveBeenCalled();
    await createNextStep({ ...BASE, applyBookingEffects: true });
    expect(m.recordLeadEvents).toHaveBeenCalledTimes(1);
    expect(m.pausePropertyEnrollments).toHaveBeenCalledTimes(1);
  });

  it("revalidates the surfaces after commit", async () => {
    supabaseWith({ data: rpcData(), error: null });
    await createNextStep(BASE);
    for (const path of ["/leads/prop-1", "/my-leads", "/messages", "/dashboard", "/calendar"]) {
      expect(m.revalidatePath).toHaveBeenCalledWith(path);
    }
  });
});
