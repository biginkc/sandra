import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, recordLeadEvent } = vi.hoisted(() => ({
  createClient: vi.fn(),
  recordLeadEvent: vi.fn().mockResolvedValue(undefined),
}));

const { applySuppressionForConfirmedReview } = vi.hoisted(() => ({
  applySuppressionForConfirmedReview: vi.fn(),
}));
vi.mock("@/lib/ai-responder/confirm-suppression", () => ({
  applySuppressionForConfirmedReview,
  SUPPRESSION_INCOMPLETE_REASON: "suppression_incomplete",
}));
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
  function retryClient(opts: { review: { id: string } | null; cleared: { id: string } | null }) {
    const updates: unknown[] = [];
    const eqs: Array<[string, unknown]> = [];
    const builder: Record<string, unknown> = {};
    let table = "";
    builder.select = () => builder;
    builder.in = () => builder;
    builder.order = () => builder;
    builder.limit = () => builder;
    builder.eq = (c: string, v: unknown) => {
      eqs.push([c, v]);
      return builder;
    };
    builder.update = (v: unknown) => {
      updates.push(v);
      return builder;
    };
    builder.maybeSingle = async () => ({
      data: table === "ai_disposition_reviews" ? opts.review : opts.cleared,
      error: null,
    });
    return {
      updates,
      eqs,
      client: {
        auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } }, error: null }) },
        from: (t: string) => {
          table = t;
          return builder;
        },
      },
    };
  }

  beforeEach(() => vi.clearAllMocks());

  it("re-runs suppression, clears the hold and audits on success", async () => {
    const { client, updates, eqs } = retryClient({ review: { id: "review-9" }, cleared: { id: "property-1" } });
    createClient.mockResolvedValue(client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: true });
    await expect(retrySuppressionForProperty("property-1")).resolves.toEqual({ ok: true, data: { cleared: true } });
    expect(applySuppressionForConfirmedReview).toHaveBeenCalledWith(client, "review-9", "user-1");
    expect(updates[0]).toMatchObject({ needs_human_attention: false, last_ai_escalation_reason: null });
    expect(eqs).toContainEqual(["last_ai_escalation_reason", "suppression_incomplete"]);
    expect(recordLeadEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "ai_escalation_cleared", payload: expect.objectContaining({ via: "retry_suppression" }) }),
    );
  });

  it("keeps the hold and returns the warning when suppression fails again", async () => {
    const { client, updates } = retryClient({ review: { id: "review-9" }, cleared: null });
    createClient.mockResolvedValue(client);
    applySuppressionForConfirmedReview.mockResolvedValue({ ok: false, warning: "Confirmed, but suppression incomplete — retry." });
    const r = await retrySuppressionForProperty("property-1");
    expect(r).toMatchObject({ ok: false, error: { message: "Confirmed, but suppression incomplete — retry." } });
    expect(updates).toHaveLength(0);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("errors when there is no confirmed opt-out/DNC review", async () => {
    const { client } = retryClient({ review: null, cleared: null });
    createClient.mockResolvedValue(client);
    await expect(retrySuppressionForProperty("property-1")).resolves.toMatchObject({ ok: false });
    expect(applySuppressionForConfirmedReview).not.toHaveBeenCalled();
  });
});
