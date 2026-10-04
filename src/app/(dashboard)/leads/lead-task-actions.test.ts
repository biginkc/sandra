import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assertPropertyDncUnlocked,
  createAdminClient,
  createClient,
  createLegacy,
  createNextStep,
  schemaReady,
} = vi.hoisted(() => ({
  assertPropertyDncUnlocked: vi.fn(),
  createAdminClient: vi.fn(),
  createClient: vi.fn(),
  createLegacy: vi.fn(),
  createNextStep: vi.fn(),
  schemaReady: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/dnc/property-lock", () => ({ assertPropertyDncUnlocked }));
vi.mock("@/lib/my-leads/schema-ready", () => ({ schemaReady }));
vi.mock("@/lib/next-steps", () => ({ createNextStep }));
vi.mock("./actions", () => ({ createLeadTaskAction: createLegacy }));

import { createLeadTaskAction } from "./lead-task-actions";

function supabaseFor(opts: {
  property: { id: string; org_id: string; address: string } | null;
  actorMembership: { user_id: string } | null;
}) {
  const builderFor = (data: unknown) => {
    const b = {
      select: vi.fn(() => b),
      eq: vi.fn(() => b),
      maybeSingle: vi.fn(async () => ({ data, error: null })),
    };
    return b;
  };
  return {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "actor-1" } } })) },
    from: vi.fn((table: string) => {
      if (table === "properties") return builderFor(opts.property);
      if (table === "memberships") return builderFor(opts.actorMembership);
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

function adminFor(assignee: Record<string, unknown> | null) {
  const b = {
    select: vi.fn(() => b),
    eq: vi.fn(() => b),
    maybeSingle: vi.fn(async () => ({
      data: assignee ? { access_status: "active", access_expires_at: null, deletion_prepared_at: null, ...assignee } : null,
      error: null,
    })),
  };
  return { from: vi.fn(() => b) };
}

const base = { dueAt: "2026-06-20T15:00:00.000Z", assigneeId: "assignee-1" };
const property = { id: "prop-1", org_id: "org-1", address: "123 Main" };

describe("createLeadTaskAction (lead page next step)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    schemaReady.mockResolvedValue(true);
    assertPropertyDncUnlocked.mockResolvedValue({ ok: true, data: null });
    createClient.mockResolvedValue(supabaseFor({ property, actorMembership: { user_id: "actor-1" } }));
    createAdminClient.mockReturnValue(adminFor({ user_id: "assignee-1" }));
  });

  it("rejects an unknown kind, a task without a title, a bad date and a missing assignee before touching anything", async () => {
    const codes: string[] = [];
    for (const input of [
      { ...base, kind: "follow_up" as never },
      { ...base, kind: "task" as const, title: "   " },
      { ...base, kind: "appointment" as const, dueAt: "nope" },
      { ...base, kind: "appointment" as const, assigneeId: "" },
    ]) {
      const r = await createLeadTaskAction("prop-1", input);
      expect(r.ok).toBe(false);
      if (!r.ok) codes.push(r.error.code);
    }
    expect(codes).toEqual(["INVALID_TASK_TYPE", "TITLE_REQUIRED", "INVALID_DUE_AT", "ASSIGNEE_REQUIRED"]);
    expect(schemaReady).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("runs the original follow-up/callback action unchanged until the schema is ready", async () => {
    schemaReady.mockResolvedValue(false);
    createLegacy.mockResolvedValue({ ok: true, data: { id: "legacy-1" } });
    const appt = await createLeadTaskAction("prop-1", { ...base, kind: "appointment", mode: "in_person", durationMinutes: 60 });
    expect(createLegacy).toHaveBeenLastCalledWith("prop-1", { type: "callback", ...base });
    expect(appt).toEqual({ ok: true, data: { id: "legacy-1", kind: "appointment", mode: "phone", calendarChainId: null } });
    await createLeadTaskAction("prop-1", { ...base, kind: "task", title: "x" });
    expect(createLegacy).toHaveBeenLastCalledWith("prop-1", { type: "follow_up", ...base });
    expect(createNextStep).not.toHaveBeenCalled();
    expect(createClient).not.toHaveBeenCalled();

    createLegacy.mockResolvedValue({ ok: false, error: { code: "ASSIGNEE_NOT_IN_ORG", message: "m" } });
    const failed = await createLeadTaskAction("prop-1", { ...base, kind: "appointment" });
    expect(failed.ok).toBe(false);
  });

  it("writes through createNextStep once ready: a phone appointment defaults its title, a task keeps its own", async () => {
    createNextStep.mockResolvedValue({ ok: true, data: { taskId: "task-7", calendarChainId: "chain-7", kind: "appointment", mode: "phone" } });
    const result = await createLeadTaskAction("prop-1", { ...base, kind: "appointment" });
    expect(result).toEqual({ ok: true, data: { id: "task-7", kind: "appointment", mode: "phone", calendarChainId: "chain-7" } });
    expect(createLegacy).not.toHaveBeenCalled();
    expect(createNextStep).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "appointment", mode: "phone", title: "Call 123 Main", propertyId: "prop-1", assigneeId: "assignee-1", dueAt: base.dueAt, origin: "app" }),
    );

    createNextStep.mockResolvedValue({ ok: true, data: { taskId: "task-8", calendarChainId: null, kind: "task", mode: "phone" } });
    await createLeadTaskAction("prop-1", { ...base, kind: "task", title: " Pull comps " });
    expect(createNextStep).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "task", title: "Pull comps", mode: undefined }));

    await createLeadTaskAction("prop-1", { ...base, kind: "appointment", mode: "in_person", durationMinutes: 45, location: "12 Oak", note: "n" });
    expect(createNextStep).toHaveBeenLastCalledWith(
      expect.objectContaining({ mode: "in_person", durationMinutes: 45, location: "12 Oak", note: "n" }),
    );
  });

  it("keeps the assignee, org and lock errors, and creates nothing", async () => {
    createAdminClient.mockReturnValue(adminFor(null));
    const outside = await createLeadTaskAction("prop-1", { ...base, kind: "appointment" });
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.error.code).toBe("ASSIGNEE_NOT_IN_ORG");

    createAdminClient.mockReturnValue(adminFor({ user_id: "former-1", access_status: "suspended" }));
    const suspended = await createLeadTaskAction("prop-1", { ...base, kind: "appointment" });
    expect(suspended.ok).toBe(false);
    if (!suspended.ok) expect(suspended.error.code).toBe("ASSIGNEE_NOT_ACTIVE");

    createClient.mockResolvedValue(supabaseFor({ property, actorMembership: null }));
    const forbidden = await createLeadTaskAction("prop-1", { ...base, kind: "appointment" });
    expect(forbidden.ok).toBe(false);
    if (!forbidden.ok) expect(forbidden.error.code).toBe("LEAD_FORBIDDEN");

    createClient.mockResolvedValue(supabaseFor({ property: null, actorMembership: { user_id: "actor-1" } }));
    const missing = await createLeadTaskAction("prop-1", { ...base, kind: "appointment" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("LEAD_NOT_FOUND");

    createClient.mockResolvedValue(supabaseFor({ property, actorMembership: { user_id: "actor-1" } }));
    assertPropertyDncUnlocked.mockResolvedValue({ ok: false, error: { code: "DNC_LOCKED", message: "locked" } });
    const locked = await createLeadTaskAction("prop-1", { ...base, kind: "appointment" });
    expect(locked.ok).toBe(false);
    if (!locked.ok) expect(locked.error.code).toBe("DNC_LOCKED");
    expect(createNextStep).not.toHaveBeenCalled();
  });
});
