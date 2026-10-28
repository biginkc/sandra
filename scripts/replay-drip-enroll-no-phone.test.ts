import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  enrollNineDrip: vi.fn(),
  enrollNurtureInDrip: vi.fn(),
  loadNurtureAutoDripConfig: vi.fn(),
  recordLeadEvent: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../src/lib/ai-responder/nine-questions-engine", () => ({ enrollNineDrip: h.enrollNineDrip }));
vi.mock("../src/lib/ai-responder/nurture-auto-drip", () => ({
  enrollNurtureInDrip: h.enrollNurtureInDrip,
  loadNurtureAutoDripConfig: h.loadNurtureAutoDripConfig,
  NURTURE_FIRST_SEND_DELAY_DAYS: { one_to_six_months: 30, six_to_twelve_months: 180, check_in_60: 60, listed_not_selling: 14 },
}));
vi.mock("../src/lib/events", () => ({ recordLeadEvent: h.recordLeadEvent }));
vi.mock("../src/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { apply, staleReason, type Fence, type Plan } from "./replay-drip-enroll-no-phone";

const PROPERTY = "11111111-1111-4111-8111-111111111111";
const FENCE: Fence = { inboundAt: "2026-10-28T15:00:00Z", ownOutboundId: "out-own", failedAt: "2026-10-28T15:00:01Z" };
const PLAN: Exclude<Plan, { kind: "skip" }> = {
  kind: "nine", fence: FENCE, contactId: "contact-replier", route: "Not interested", drip: "Not interested", skipFirstStep: false,
};

type Filter = [op: string, column: string, value: unknown];
type Call = { table: string; filters: Filter[]; update?: Record<string, unknown> };

/**
 * Fake client. `counts(table, filters)` answers every `head` count; the
 * property row answers `maybeSingle`; updates are recorded and succeed.
 */
function fakeClient(opts: { counts: (call: Call) => number; property?: Record<string, unknown> }) {
  const calls: Call[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, filters: [] };
      let head = false;
      const b = {
        select: (_cols?: string, o?: { head?: boolean }) => { head = Boolean(o?.head); return b; },
        update: (row: Record<string, unknown>) => { call.update = row; return b; },
        eq: (c: string, v: unknown) => { call.filters.push(["eq", c, v]); return b; },
        neq: (c: string, v: unknown) => { call.filters.push(["neq", c, v]); return b; },
        gt: (c: string, v: unknown) => { call.filters.push(["gt", c, v]); return b; },
        gte: (c: string, v: unknown) => { call.filters.push(["gte", c, v]); return b; },
        maybeSingle: async () => ({
          data: opts.property ?? { needs_human_attention: true, last_ai_escalation_reason: "drip_enroll_failed:no_phone", homeowner_contact_id: null },
          error: null,
        }),
        then: (resolve: (v: unknown) => void) => {
          calls.push(call);
          resolve(head ? { count: opts.counts(call), error: null } : { data: call.update ? [{ id: "x" }] : [], error: null });
        },
      };
      return b;
    },
  };
  return { client, calls };
}

const has = (call: Call, op: string, column: string, value?: unknown) =>
  call.filters.some(([o, c, v]) => o === op && c === column && (value === undefined || v === value));

beforeEach(() => {
  vi.clearAllMocks();
  h.loadNurtureAutoDripConfig.mockResolvedValue({ enabled: true, sequences: {} });
  h.enrollNineDrip.mockResolvedValue({ status: "enrolled", sequenceId: "seq", enrollmentId: "enr-new" });
});

describe("staleReason", () => {
  it("is fresh when nothing happened since the failure", async () => {
    const { client } = fakeClient({ counts: () => 0 });
    expect(await staleReason(client as never, PROPERTY, FENCE)).toBeNull();
  });

  it("any enrolment since the failure (including a cancelled one) blocks a replay", async () => {
    const { client, calls } = fakeClient({ counts: (c) => (c.table === "sequence_enrollments" ? 1 : 0) });
    expect(await staleReason(client as never, PROPERTY, FENCE)).toMatch(/drip was started \(or cancelled\)/);
    const enr = calls.find((c) => c.table === "sequence_enrollments")!;
    expect(has(enr, "gte", "enrolled_at", FENCE.failedAt)).toBe(true);
    // No status filter: completed/cancelled rows count too.
    expect(enr.filters.some(([, c]) => c === "status")).toBe(false);
  });

  it("ignores only the run's own reply among outbound texts", async () => {
    const { client, calls } = fakeClient({ counts: () => 0 });
    await staleReason(client as never, PROPERTY, FENCE);
    const out = calls.find((c) => c.table === "messages" && has(c, "eq", "direction", "outbound"))!;
    expect(has(out, "neq", "id", "out-own")).toBe(true);
  });
});

describe("apply", () => {
  it("enrols with the replier, holds the first text, and clears the hold when still fresh", async () => {
    const { client, calls } = fakeClient({ counts: () => 0 });
    const before = Date.now();
    expect(await apply(client as never, PROPERTY, PLAN)).toBe("enrolled; hold cleared");
    const args = h.enrollNineDrip.mock.calls[0]![1] as { contactId: string; firstSendNotBefore: Date };
    expect(args.contactId).toBe("contact-replier");
    expect(args.firstSendNotBefore.getTime() - before).toBeGreaterThanOrEqual(15 * 60_000 - 1000);
    const clear = calls.find((c) => c.table === "properties" && c.update)!;
    expect(has(clear, "eq", "last_ai_escalation_reason", "drip_enroll_failed:no_phone")).toBe(true);
  });

  it("a seller reply that lands while enrolling pauses the new drip and keeps the hold", async () => {
    let enrolled = false;
    h.enrollNineDrip.mockImplementation(async () => { enrolled = true; return { status: "enrolled", sequenceId: "seq", enrollmentId: "enr-new" }; });
    const { client, calls } = fakeClient({
      counts: (c) => (enrolled && c.table === "messages" && has(c, "eq", "direction", "inbound") ? 1 : 0),
    });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^enrolled then paused \(seller texted again/);
    const pause = calls.find((c) => c.table === "sequence_enrollments" && c.update)!;
    expect(pause.update).toMatchObject({ status: "paused", pause_reason: "inbound_reply" });
    expect(has(pause, "eq", "id", "enr-new")).toBe(true);
    expect(calls.some((c) => c.table === "properties" && c.update)).toBe(false);
  });

  it("the post-enrol check does not count the run's own new enrolment", async () => {
    let enrolled = false;
    h.enrollNineDrip.mockImplementation(async () => { enrolled = true; return { status: "enrolled", sequenceId: "seq", enrollmentId: "enr-new" }; });
    // After enrolling, the new row exists; it only counts if not excluded by id.
    const { client } = fakeClient({ counts: (c) => (enrolled && c.table === "sequence_enrollments" && !has(c, "neq", "id", "enr-new") ? 1 : 0) });
    expect(await apply(client as never, PROPERTY, PLAN)).toBe("enrolled; hold cleared");
  });

  it("a drip cancelled after an earlier replay is never restarted", async () => {
    const { client } = fakeClient({ counts: (c) => (c.table === "sequence_enrollments" ? 1 : 0) });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^skipped: a drip was started \(or cancelled\)/);
    expect(h.enrollNineDrip).not.toHaveBeenCalled();
  });

  it("a drip that went live meanwhile keeps the hold", async () => {
    h.enrollNineDrip.mockResolvedValueOnce({ status: "already_enrolled", sequenceId: "seq" });
    const { client, calls } = fakeClient({ counts: () => 0 });
    expect(await apply(client as never, PROPERTY, PLAN)).toMatch(/^skipped: a drip went live meanwhile/);
    expect(calls.some((c) => c.table === "properties" && c.update)).toBe(false);
  });
});

describe("entrypoint", () => {
  it("starts with the documented command (server-only imports load)", () => {
    const result = spawnSync(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/replay-drip-enroll-no-phone.ts", "--help"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
    });
    expect(result.stderr).not.toMatch(/server-only|cannot be imported/i);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--apply");
  });
});
