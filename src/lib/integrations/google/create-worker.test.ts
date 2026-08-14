import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./dispatch", () => ({
  buildCalendarClient: vi.fn(),
  isGoogleConflict: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { status?: unknown; code?: unknown };
    return candidate.status === 409 || candidate.code === 409;
  },
}));
vi.mock("@/lib/integrations/prefs", () => ({
  loadIntegrationPrefs: vi.fn(),
}));
vi.mock("@/lib/integrations/tokens/store", () => ({
  getDecryptedToken: vi.fn(),
}));
vi.mock("@/lib/errors/report", () => ({
  reportError: vi.fn(),
}));

import {
  processClaimedCalendarCreation,
  type ClaimedCalendarCreationRow,
} from "./create-worker";
import { buildCalendarClient } from "./dispatch";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { getDecryptedToken } from "@/lib/integrations/tokens/store";

/** Same thenable, infinitely-chainable fake Postgrest builder used in
 *  src/lib/messaging/send.test.ts — resolves to a fixed result regardless
 *  of which chain methods are called on the way there. */
function chain(result: { data: unknown; error: { message: string } | null }) {
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    update: () => builder,
    maybeSingle: () => Promise.resolve(result),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  return builder;
}

function fakeSupabase(
  queues: Record<string, Array<{ data: unknown; error: { message: string } | null }>>,
) {
  return {
    from: (table: string) => {
      const q = queues[table];
      if (!q || q.length === 0) {
        throw new Error(`fakeSupabase: no queued result for table "${table}"`);
      }
      return chain(q.shift()!);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const BASE_CLAIMED: ClaimedCalendarCreationRow = {
  ledger_id: "ledger-1",
  org_id: "org-1",
  calendar_chain_id: "chain-1",
  source_task_id: "task-1",
  expected_generation: 0,
  client_event_id: "evtclient1",
  attempts: 1,
  task_due_at: "2026-09-01T15:00:00.000Z",
  task_end_at: "2026-09-01T15:30:00.000Z",
  task_title: "Walkthrough",
  task_assignee_id: "assignee-1",
};

const FAKE_TOKEN = { accessToken: { reveal: () => "tok" } } as never;

beforeEach(() => {
  vi.mocked(loadIntegrationPrefs).mockResolvedValue({
    calendarEnabled: true,
    slackEnabled: true,
    timezone: "America/Chicago",
  });
  vi.mocked(getDecryptedToken).mockResolvedValue(FAKE_TOKEN);
});

describe("processClaimedCalendarCreation", () => {
  it("pref_disabled: finalizes with a NULL event, no calendar client built", async () => {
    vi.mocked(loadIntegrationPrefs).mockResolvedValue({
      calendarEnabled: false,
      slackEnabled: true,
      timezone: "America/Chicago",
    });
    const supabase = fakeSupabase({
      task_calendar_mutations: [{ data: null, error: null }], // finalize no-op
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(outcome).toEqual({ status: "pref_disabled", ledgerId: "ledger-1" });
    expect(buildCalendarClient).not.toHaveBeenCalled();
  });

  it("no_token: finalizes with a NULL event, no calendar client built", async () => {
    vi.mocked(getDecryptedToken).mockResolvedValue(null);
    const supabase = fakeSupabase({
      task_calendar_mutations: [{ data: null, error: null }], // finalize no-op
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(outcome).toEqual({ status: "no_token", ledgerId: "ledger-1" });
    expect(buildCalendarClient).not.toHaveBeenCalled();
  });

  it("created: happy path advances provider_done -> finalized and stamps the task", async () => {
    const insert = vi.fn().mockResolvedValue({ data: { id: "evt-1" } });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [
        { data: null, error: null }, // provider_done
        { data: null, error: null }, // finalized
      ],
      tasks: [{ data: { id: "task-1" }, error: null }], // finalize CAS success
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(insert).toHaveBeenCalledWith({
      calendarId: "primary",
      requestBody: expect.objectContaining({ id: "evtclient1" }),
    });
    expect(outcome).toEqual({ status: "created", ledgerId: "ledger-1", eventId: "evt-1" });
  });

  it("reconciled_409: insert conflicts, reconciles via events.get, still finalizes", async () => {
    const insert = vi.fn().mockRejectedValue({ status: 409 });
    const get = vi.fn().mockResolvedValue({ data: { id: "evt-2" } });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [
        { data: null, error: null }, // provider_done
        { data: null, error: null }, // finalized
      ],
      tasks: [{ data: { id: "task-1" }, error: null }],
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(get).toHaveBeenCalledWith({ calendarId: "primary", eventId: "evtclient1" });
    expect(outcome).toEqual({
      status: "reconciled_409",
      ledgerId: "ledger-1",
      eventId: "evt-2",
    });
  });

  it("retryable_error: a 503 leaves the ledger row pending with last_error set, no provider_done write", async () => {
    const insert = vi.fn().mockRejectedValue({ status: 503, message: "backend error" });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [{ data: null, error: null }], // last_error update, stays pending
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(outcome.status).toBe("retryable_error");
  });

  it("permanent_error: a 403 terminal-fails the ledger row", async () => {
    const insert = vi.fn().mockRejectedValue({ status: 403, message: "forbidden" });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [{ data: null, error: null }], // phase='failed' write
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(outcome.status).toBe("permanent_error");
  });

  it("finalize CAS: provider succeeds but the task's generation moved — leaves provider_done, never resurrects", async () => {
    const insert = vi.fn().mockResolvedValue({ data: { id: "evt-3" } });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [{ data: null, error: null }], // provider_done write succeeds
      tasks: [{ data: null, error: null }], // CAS: 0 rows matched — generation moved
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(outcome).toEqual({
      status: "finalize_conflict",
      ledgerId: "ledger-1",
      eventId: "evt-3",
    });
  });
});
