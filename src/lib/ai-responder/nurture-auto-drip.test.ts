import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enrollLead: vi.fn(),
  config: { data: null as unknown, error: null as { message: string } | null },
  promoted: { data: { id: "p1" } as unknown, error: null as { message: string } | null },
  current: { data: { outreach_dispo: "needs_sequence" } as unknown, error: null as { message: string } | null },
  updates: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { DISPO_SET: "dispo_set" },
  recordLeadEvent: vi.fn(async () => undefined),
}));
vi.mock("@/lib/sequences/enrollment", () => ({ enrollLead: mocks.enrollLead }));

import { enrollNurtureInDrip, loadNurtureAutoDripConfig } from "./nurture-auto-drip";

function builder(result: () => unknown, onUpdate?: (v: Record<string, unknown>) => void) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq"]) b[m] = () => b;
  b.update = (v: Record<string, unknown>) => {
    onUpdate?.(v);
    return b;
  };
  b.maybeSingle = async () => result();
  b.then = (resolve: (v: unknown) => unknown) => resolve(result());
  return b;
}
const supabase = {
  from: (table: string) =>
    table === "ai_responder_configs"
      ? builder(() => mocks.config)
      : (() => {
          let isUpdate = false;
          const b = builder(() => (isUpdate ? mocks.promoted : mocks.current), (v) => {
            isUpdate = true;
            mocks.updates.push(v);
          });
          return b;
        })(),
} as never;

beforeEach(() => {
  mocks.enrollLead.mockReset();
  mocks.updates = [];
  mocks.promoted = { data: { id: "p1" }, error: null };
  mocks.current = { data: { outreach_dispo: "needs_sequence" }, error: null };
});

describe("loadNurtureAutoDripConfig", () => {
  it("is off when there is no row or the flag is false (default)", async () => {
    mocks.config = { data: null, error: null };
    expect(await loadNurtureAutoDripConfig(supabase, "org")).toEqual({ enabled: false });
    mocks.config = { data: { nurture_auto_drip: false, nurture_auto_drip_sequence_id: "s" }, error: null };
    expect(await loadNurtureAutoDripConfig(supabase, "org")).toEqual({ enabled: false });
  });
  it("returns the owner's drip when on", async () => {
    mocks.config = { data: { nurture_auto_drip: true, nurture_auto_drip_sequence_id: "s1" }, error: null };
    expect(await loadNurtureAutoDripConfig(supabase, "org")).toEqual({ enabled: true, sequenceId: "s1" });
  });
  it("returns null (callers fail closed) when unreadable", async () => {
    mocks.config = { data: null, error: { message: "boom" } };
    expect(await loadNurtureAutoDripConfig(supabase, "org")).toBeNull();
  });
});

describe("enrollNurtureInDrip", () => {
  it("never enrols without a configured drip", async () => {
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: null })).toEqual({ status: "refused", reason: "no_drip_configured" });
    expect(mocks.enrollLead).not.toHaveBeenCalled();
    expect(mocks.updates).toEqual([]);
  });
  it("enrols through the shared enrollLead with the configured drip and no human actor", async () => {
    mocks.enrollLead.mockResolvedValue({ status: "enrolled", enrollmentId: "e1", sequenceLabel: "x" });
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "enrolled", sequenceId: "s1", enrollmentId: "e1" });
    expect(mocks.enrollLead).toHaveBeenCalledTimes(1);
    expect(mocks.enrollLead).toHaveBeenCalledWith(supabase, { propertyId: "p1", sequenceId: "s1", enrolledByUserId: null });
  });
  it("a refusal reverts the release and reports the reason", async () => {
    mocks.enrollLead.mockResolvedValue({ status: "no_consent", message: "m" });
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "refused", reason: "no_consent" });
    expect(mocks.updates.map((u) => u.outreach_dispo)).toEqual(["needs_sequence", "nurture"]);
  });
  it("a thrown enrolment is a refusal, never an exception", async () => {
    mocks.enrollLead.mockRejectedValue(new Error("db down"));
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "refused", reason: "enroll_failed" });
    expect(mocks.updates.map((u) => u.outreach_dispo)).toEqual(["needs_sequence", "nurture"]);
  });
  it("a changed outcome is refused without enrolling or reverting anything", async () => {
    mocks.promoted = { data: null, error: null };
    mocks.current = { data: { outreach_dispo: "not_interested" }, error: null };
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "refused", reason: "outcome_changed" });
    expect(mocks.enrollLead).not.toHaveBeenCalled();
  });
  it("a replay on an already-released lead enrols idempotently and does not revert on duplicate", async () => {
    mocks.promoted = { data: null, error: null };
    mocks.enrollLead.mockResolvedValue({ status: "duplicate_active" });
    expect(await enrollNurtureInDrip(supabase, { propertyId: "p1", sequenceId: "s1" })).toEqual({ status: "already_enrolled", sequenceId: "s1" });
  });
});
