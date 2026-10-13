import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, recordLeadEvent } = vi.hoisted(() => ({
  createClient: vi.fn(),
  recordLeadEvent: vi.fn().mockResolvedValue(undefined),
}));

const { applySuppressionForConfirmedReview, recordSuppressionRetriedOk } = vi.hoisted(() => ({
  applySuppressionForConfirmedReview: vi.fn(),
  recordSuppressionRetriedOk: vi.fn(),
}));
vi.mock("@/lib/ai-responder/confirm-suppression", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/ai-responder/confirm-suppression")>()),
  applySuppressionForConfirmedReview,
  recordSuppressionRetriedOk,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
import { createAdminClient } from "@/lib/supabase/admin";
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    AI_ESCALATION_CLEARED: "ai_escalation_cleared",
    AI_RESPONDER_TOGGLED: "ai_responder_toggled",
    SKIP_TRACE_TOGGLED: "skip_trace_toggled",
  },
  recordLeadEvent,
}));

import { suppressionIncompleteReason, suppressionReviewIdsFromReason } from "@/lib/ai-responder/confirm-suppression";
import {
  clearNeedsHumanAttention,
  setAiResponderDisabled,
  retrySuppressionForProperty,
  setSkipTraceDisabled,
} from "./ai-actions";

type ActionCase = {
  name: string;
  run: () => Promise<unknown>;
  eventType: string;
  filterColumn: string;
  filterValue: boolean;
  payload: { from: boolean; to: boolean };
};

function actionCases(): ActionCase[] {
  return [
    {
      name: "attention clear",
      run: () => clearNeedsHumanAttention("property-1"),
      eventType: "ai_escalation_cleared",
      filterColumn: "needs_human_attention",
      filterValue: true,
      payload: { from: true, to: false },
    },
    {
      name: "AI responder toggle",
      run: () => setAiResponderDisabled("property-1", true),
      eventType: "ai_responder_toggled",
      filterColumn: "ai_responder_disabled",
      filterValue: false,
      payload: { from: false, to: true },
    },
    {
      name: "skip-trace toggle",
      run: () => setSkipTraceDisabled("property-1", true),
      eventType: "skip_trace_toggled",
      filterColumn: "skip_trace_disabled",
      filterValue: false,
      payload: { from: false, to: true },
    },
  ];
}

function makeClient(options?: {
  userId?: string | null;
  authError?: { message: string } | null;
  updated?: { id: string } | null;
  updateError?: { message: string } | null;
}) {
  const eq = vi.fn(() => builder);
  const builder = {
    update: vi.fn(() => builder),
    eq,
    select: vi.fn(() => builder),
    maybeSingle: vi.fn().mockResolvedValue({
      data: options?.updated === undefined ? { id: "property-1" } : options.updated,
      error: options?.updateError ?? null,
    }),
  };
  return {
    client: {
      auth: {
        getUser: vi.fn().mockResolvedValue({
          data: {
            user:
              options?.userId === null
                ? null
                : { id: options?.userId ?? "user-1" },
          },
          error: options?.authError ?? null,
        }),
      },
      from: vi.fn(() => builder),
    },
    eq,
  };
}

describe("lead AI actions ledger", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  for (const action of actionCases()) {
    it(`records only a confirmed ${action.name}`, async () => {
      const { client, eq } = makeClient();
      createClient.mockResolvedValue(client);

      await expect(action.run()).resolves.toMatchObject({ ok: true });
      expect(eq).toHaveBeenCalledWith(action.filterColumn, action.filterValue);
      expect(recordLeadEvent).toHaveBeenCalledWith({
        propertyId: "property-1",
        actorType: "user",
        actorId: "user-1",
        eventType: action.eventType,
        payload: action.payload,
      });
    });

    it(`does not record a ${action.name} no-op`, async () => {
      const { client } = makeClient({ updated: null });
      createClient.mockResolvedValue(client);

      await expect(action.run()).resolves.toMatchObject({ ok: true });
      expect(recordLeadEvent).not.toHaveBeenCalled();
    });

    it(`does not record a failed ${action.name} update`, async () => {
      const { client } = makeClient({
        updated: null,
        updateError: { message: "write failed" },
      });
      createClient.mockResolvedValue(client);

      await expect(action.run()).resolves.toMatchObject({ ok: false });
      expect(recordLeadEvent).not.toHaveBeenCalled();
    });

    it(`does not mutate or record ${action.name} without authentication`, async () => {
      const { client } = makeClient({
        userId: null,
        authError: { message: "expired" },
      });
      createClient.mockResolvedValue(client);

      await expect(action.run()).resolves.toMatchObject({
        ok: false,
        error: { code: "UNAUTHENTICATED" },
      });
      expect(client.from).not.toHaveBeenCalled();
      expect(recordLeadEvent).not.toHaveBeenCalled();
    });
  }
});

// Ordinary-record unit fixtures isolate the independently tested training lookup.
vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: vi.fn().mockResolvedValue(undefined) }));

describe("retrySuppressionForProperty", () => {
  type Ev = { event_type: string; source_id: string; created_at: string };
  type State = {
    reason: string | null;
    events: Ev[];
    reviews: string[]; // confirmed opted_out/dnc review ids
    latest?: string | null;
    clearRpcError?: boolean;
    /** Runs inside the database, right before the clear function takes its lock (a concurrent writer). */
    beforeClear?: () => void;
  };

  /** Stateful fake: retried_ok writes land in `events`, reason updates honour the eq guard. */
  function world(state: State) {
    const updates: Array<{ values: Record<string, unknown>; matched: boolean }> = [];
    const client = {
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }) },
      from: (table: string) => {
        const filters: Array<[string, unknown]> = [];
        let inIds: string[] | null = null;
        let pending: Record<string, unknown> | null = null;
        const c: Record<string, unknown> = {};
        c.select = () => c;
        c.order = () => c;
        c.limit = () => c;
        c.eq = (col: string, v: unknown) => {
          filters.push([col, v]);
          return c;
        };
        c.in = (col: string, v: string[]) => {
          if (table === "ai_disposition_reviews" && col === "id") {
            inIds = v;
            return c;
          }
          if (table === "lead_events") return Promise.resolve({ data: state.events, error: null });
          return c;
        };
        c.or = () => c;
        c.update = (v: Record<string, unknown>) => {
          pending = v;
          return c;
        };
        const settle = () => {
          if (table === "properties" && pending) {
            const guard = filters.find(([col]) => col === "last_ai_escalation_reason");
            const matched = !guard || guard[1] === state.reason;
            updates.push({ values: pending, matched });
            if (matched && "last_ai_escalation_reason" in pending) {
              state.reason = pending.last_ai_escalation_reason as string | null;
            }
            return matched ? { id: "property-1" } : null;
          }
          return null;
        };
        c.maybeSingle = async () => {
          if (table === "properties" && !pending) {
            return { data: { last_ai_escalation_reason: state.reason }, error: null };
          }
          if (table === "properties") return { data: settle(), error: null };
          if (table === "ai_disposition_reviews") {
            return { data: state.latest ? { id: state.latest } : null, error: null };
          }
          return { data: null, error: null };
        };
        c.then = (resolve: (v: unknown) => void) => {
          if (table === "ai_disposition_reviews") {
            const ids = (inIds ?? []).filter((id) => state.reviews.includes(id));
            return resolve({ data: ids.map((id) => ({ id })), error: null });
          }
          if (table === "properties" && pending) {
            return resolve({ data: settle(), error: null });
          }
          return resolve({ data: null, error: null });
        };
        return c;
      },
    };
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
    /** Mirrors fn_clear_suppression_hold_if_resolved; synchronous = atomic under the row lock. */
    const clearIfResolved = () => {
      state.beforeClear?.();
      const resolved = (id: string) => {
        const failedAt = state.events.filter((e) => e.event_type === "suppression_incomplete" && e.source_id === id).map((e) => e.created_at).sort().at(-1) ?? "";
        return state.events.some((e) => e.event_type === "suppression_retried_ok" && e.source_id === id && e.created_at >= failedAt);
      };
      const isHold = !!state.reason && (state.reason === "suppression_incomplete" || state.reason.startsWith("suppression_incomplete:"));
      const ledgerFailed = [...new Set(state.events.filter((e) => e.event_type === "suppression_incomplete").map((e) => e.source_id))];
      const pointer = suppressionReviewIdsFromReason(state.reason).filter((i) => !resolved(i));
      const outstanding = [...new Set([...pointer, ...ledgerFailed.filter((i) => !resolved(i))])];
      if (!isHold) return { cleared: false, outstanding_ids: outstanding };
      if (outstanding.length === 0) {
        state.reason = null;
        return { cleared: true, outstanding_ids: [] as string[] };
      }
      state.reason = suppressionIncompleteReason(outstanding);
      return { cleared: false, outstanding_ids: outstanding };
    };
    vi.mocked(createAdminClient).mockReturnValue({
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        await Promise.resolve();
        if (state.clearRpcError) return { data: null, error: { message: "clear failed" } };
        return { data: [clearIfResolved()], error: null };
      },
    } as never);
    recordSuppressionRetriedOk.mockImplementation(async ({ reviewId }: { reviewId: string }) => {
      state.events.push({ event_type: "suppression_retried_ok", source_id: reviewId, created_at: "2026-02-01" });
    });
    return { client, updates, state, rpcCalls };
  }
  const failedEv = (id: string, at = "2026-01-01"): Ev => ({
    event_type: "suppression_incomplete",
    source_id: id,
    created_at: at,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("retries the review named in the reason, records it, and clears the hold on success", async () => {
    const w = world({ reason: "suppression_incomplete:A", events: [failedEv("A")], reviews: ["A", "B"] });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: true });
    await expect(retrySuppressionForProperty("property-1")).resolves.toEqual({
      ok: true,
      data: { cleared: true, remaining: 0 },
    });
    expect(applySuppressionForConfirmedReview).toHaveBeenCalledTimes(1);
    expect(applySuppressionForConfirmedReview).toHaveBeenCalledWith(w.client, "A", "user-1");
    expect(recordSuppressionRetriedOk).toHaveBeenCalledWith({
      propertyId: "property-1",
      reviewId: "A",
      actorId: "user-1",
    });
    expect(w.state.reason).toBeNull();
    expect(recordLeadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "ai_escalation_cleared", payload: expect.objectContaining({ via: "retry_suppression" }) }),
    );
  });

  it("two-review interleaving: B succeeded earlier, A fails later -> retry targets A only, B untouched; A success clears", async () => {
    // B failed then was retried OK (resolved); A failed afterwards and owns the hold.
    const w = world({
      reason: "suppression_incomplete:A",
      events: [
        failedEv("B", "2026-01-01"),
        { event_type: "suppression_retried_ok", source_id: "B", created_at: "2026-01-02" },
        failedEv("A", "2026-01-03"),
      ],
      reviews: ["A", "B"],
      latest: "B", // the old behaviour would have picked the latest-confirmed review
    });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: true });
    const r = await retrySuppressionForProperty("property-1");
    expect(applySuppressionForConfirmedReview).toHaveBeenCalledTimes(1);
    expect(applySuppressionForConfirmedReview.mock.calls[0][1]).toBe("A");
    expect(r).toEqual({ ok: true, data: { cleared: true, remaining: 0 } });
  });

  it("does not clear the hold while another failed review is still outstanding (partial success)", async () => {
    const w = world({
      reason: "suppression_incomplete:A",
      events: [failedEv("A"), failedEv("B", "2026-01-02")],
      reviews: ["A", "B"],
    });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockImplementation(async (_c: unknown, id: string) =>
      id === "A" ? { ok: true } : { ok: false, warning: "Confirmed, but suppression incomplete — retry." },
    );
    const r = await retrySuppressionForProperty("property-1");
    expect(r).toMatchObject({ ok: false, error: { code: "SUPPRESSION_INCOMPLETE" } });
    expect(recordSuppressionRetriedOk).toHaveBeenCalledTimes(1);
    expect(recordSuppressionRetriedOk).toHaveBeenCalledWith(expect.objectContaining({ reviewId: "A" }));
    expect(w.state.reason).toBe("suppression_incomplete:B");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("a failed clear call is reported and leaves the hold exactly as it was", async () => {
    const w = world({
      reason: "suppression_incomplete:A",
      events: [failedEv("A")],
      reviews: ["A"],
      clearRpcError: true,
    });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: true });
    const r = await retrySuppressionForProperty("property-1");
    expect(r).toMatchObject({ ok: false, error: { code: "CLEAR_ATTENTION_FAILED", message: "clear failed" } });
    expect(w.state.reason).toBe("suppression_incomplete:A");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("the clear is one database call and the action never writes the hold itself", async () => {
    const w = world({ reason: "suppression_incomplete:A", events: [failedEv("A")], reviews: ["A"] });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: true });
    await retrySuppressionForProperty("property-1");
    expect(w.rpcCalls).toEqual([{ name: "fn_clear_suppression_hold_if_resolved", args: { p_property_id: "property-1" } }]);
    expect(w.updates).toHaveLength(0);
  });

  it("a concurrent new failure is not cleared by an older successful retry", async () => {
    const w = world({ reason: "suppression_incomplete:A", events: [failedEv("A")], reviews: ["A", "C"] });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockImplementation(async () => {
      // while A's retry runs, review C fails and takes over the hold
      w.state.events.push(failedEv("C", "2026-01-05"));
      w.state.reason = "suppression_incomplete:C";
      return { ok: true };
    });
    const r = await retrySuppressionForProperty("property-1");
    expect(r).toEqual({ ok: true, data: { cleared: false, remaining: 1 } });
    expect(w.state.reason).toBe("suppression_incomplete:C");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("retry A reads zero outstanding; B fails and its backfill of A fails (pointer stays A): the clear sees B and does not clear", async () => {
    const w = world({ reason: "suppression_incomplete:A", events: [failedEv("A")], reviews: ["A"] });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: true });
    // Lands after the retry's last read, before the clear takes the row lock:
    // B's ledger row is recorded; the pointer is left on A.
    w.state.beforeClear = () => w.state.events.push(failedEv("B", "2026-03-01"));
    const r = await retrySuppressionForProperty("property-1");
    expect(r).toEqual({ ok: true, data: { cleared: false, remaining: 1 } });
    expect(w.state.reason).toBe("suppression_incomplete:B");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("timeout flag preserved: retries the review from the lead event, records it, and leaves the timeout hold", async () => {
    const w = world({ reason: "send_timeout:msg-1", events: [failedEv("A")], reviews: ["A"] });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: true });
    const r = await retrySuppressionForProperty("property-1");
    expect(applySuppressionForConfirmedReview).toHaveBeenCalledWith(w.client, "A", "user-1");
    expect(recordSuppressionRetriedOk).toHaveBeenCalledWith(expect.objectContaining({ reviewId: "A" }));
    expect(r).toEqual({ ok: true, data: { cleared: false, remaining: 0 } });
    expect(w.state.reason).toBe("send_timeout:msg-1");
    expect(w.updates).toHaveLength(0);
  });

  it("multi-id reason: retry B succeeds -> A still outstanding, hold kept and reason drops B", async () => {
    const w = world({ reason: "suppression_incomplete:A,B", events: [], reviews: ["A", "B"] });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockImplementation(async (_c: unknown, id: string) =>
      id === "B" ? { ok: true } : { ok: false, warning: "Confirmed, but suppression incomplete — retry." },
    );
    const r = await retrySuppressionForProperty("property-1");
    expect(r).toMatchObject({ ok: false, error: { code: "SUPPRESSION_INCOMPLETE" } });
    expect(applySuppressionForConfirmedReview.mock.calls.map((c) => c[1]).sort()).toEqual(["A", "B"]);
    expect(recordSuppressionRetriedOk).toHaveBeenCalledTimes(1);
    expect(recordSuppressionRetriedOk).toHaveBeenCalledWith(expect.objectContaining({ reviewId: "B" }));
    expect(w.state.reason).toBe("suppression_incomplete:A");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("three ids in the reason: all must resolve before the hold clears", async () => {
    const w = world({ reason: "suppression_incomplete:A,B,C", events: [], reviews: ["A", "B", "C"] });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: true });
    const r = await retrySuppressionForProperty("property-1");
    expect(applySuppressionForConfirmedReview).toHaveBeenCalledTimes(3);
    expect(r).toEqual({ ok: true, data: { cleared: true, remaining: 0 } });
    expect(w.state.reason).toBeNull();
  });

  it("three ids, one still failing: reason keeps only the unresolved id", async () => {
    const w = world({ reason: "suppression_incomplete:A,B,C", events: [], reviews: ["A", "B", "C"] });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockImplementation(async (_c: unknown, id: string) =>
      id === "C" ? { ok: false, warning: "Confirmed, but suppression incomplete — retry." } : { ok: true },
    );
    await retrySuppressionForProperty("property-1");
    expect(w.state.reason).toBe("suppression_incomplete:C");
  });

  it("keeps the hold and returns the warning when suppression fails again", async () => {
    const w = world({ reason: "suppression_incomplete:A", events: [failedEv("A")], reviews: ["A"] });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: false, warning: "Confirmed, but suppression incomplete — retry." });
    const r = await retrySuppressionForProperty("property-1");
    expect(r).toMatchObject({ ok: false, error: { message: "Confirmed, but suppression incomplete — retry." } });
    expect(recordSuppressionRetriedOk).not.toHaveBeenCalled();
    expect(w.state.reason).toBe("suppression_incomplete:A");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("legacy bare suppression_incomplete hold with no recorded id falls back to the latest confirmed review", async () => {
    const w = world({ reason: "suppression_incomplete", events: [], reviews: ["Z"], latest: "Z" });
    createClient.mockResolvedValue(w.client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: true });
    await expect(retrySuppressionForProperty("property-1")).resolves.toEqual({
      ok: true,
      data: { cleared: true, remaining: 0 },
    });
    expect(applySuppressionForConfirmedReview.mock.calls[0][1]).toBe("Z");
  });

  it("ignores failed ids that are not confirmed opt-out/DNC reviews of this property", async () => {
    const w = world({ reason: "suppression_incomplete:A", events: [failedEv("A")], reviews: [] });
    createClient.mockResolvedValue(w.client);
    await expect(retrySuppressionForProperty("property-1")).resolves.toMatchObject({ ok: false });
    expect(applySuppressionForConfirmedReview).not.toHaveBeenCalled();
  });

  it("errors when nothing is outstanding", async () => {
    const w = world({ reason: "low_confidence", events: [], reviews: ["A"] });
    createClient.mockResolvedValue(w.client);
    await expect(retrySuppressionForProperty("property-1")).resolves.toMatchObject({ ok: false });
    expect(applySuppressionForConfirmedReview).not.toHaveBeenCalled();
  });
});

describe("listOutstandingSuppressionFailures", () => {
  it("returns the outstanding review ids for the banner", async () => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.in = async () => ({
      data: [{ event_type: "suppression_incomplete", source_id: "A", created_at: "2026-01-01" }],
      error: null,
    });
    c.maybeSingle = async () => ({ data: { last_ai_escalation_reason: "send_timeout:x" }, error: null });
    createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }) },
      from: () => c,
    });
    const { listOutstandingSuppressionFailures } = await import("./ai-actions");
    await expect(listOutstandingSuppressionFailures("property-1")).resolves.toEqual({
      ok: true,
      data: { reviewIds: ["A"] },
    });
  });

  it("uses the LIST_SUPPRESSION_FAILED code when the ledger cannot be read", async () => {
    const c: Record<string, unknown> = {};
    c.select = () => c;
    c.eq = () => c;
    c.in = async () => ({ data: null, error: { message: "boom" } });
    c.maybeSingle = async () => ({ data: { last_ai_escalation_reason: null }, error: null });
    createClient.mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }) },
      from: () => c,
    });
    const { listOutstandingSuppressionFailures } = await import("./ai-actions");
    await expect(listOutstandingSuppressionFailures("property-1")).resolves.toMatchObject({
      ok: false,
      error: { code: "LIST_SUPPRESSION_FAILED" },
    });
  });
});
