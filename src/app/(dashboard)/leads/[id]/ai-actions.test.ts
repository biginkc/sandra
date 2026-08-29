import { beforeEach, describe, expect, it, vi } from "vitest";

const { createClient, recordLeadEvent } = vi.hoisted(() => ({
  createClient: vi.fn(),
  recordLeadEvent: vi.fn().mockResolvedValue(undefined),
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
