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

/** A round-7 ledger write (task_calendar_mutations, post-claim) resolves via
 *  `.select("id")`, so "one row changed" is `data: [{id}]` and "lease lost /
 *  already advanced past the expected phase" is `data: []`. */
function ledgerWrite(applied = true) {
  return { data: applied ? [{ id: "ledger-1" }] : [], error: null };
}

const BASE_CLAIMED: ClaimedCalendarCreationRow = {
  ledger_id: "ledger-1",
  org_id: "org-1",
  calendar_chain_id: "chain-1",
  source_task_id: "task-1",
  expected_generation: 0,
  client_event_id: "evtclient1",
  attempts: 1,
  phase: "pending",
  new_event_id: null,
  result_reason: null,
  claim_token: "token-1",
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
      task_calendar_mutations: [ledgerWrite()], // finalize no-op
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(outcome).toEqual({ status: "pref_disabled", ledgerId: "ledger-1" });
    expect(buildCalendarClient).not.toHaveBeenCalled();
  });

  it("no_token: finalizes with a NULL event, no calendar client built", async () => {
    vi.mocked(getDecryptedToken).mockResolvedValue(null);
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite()], // finalize no-op
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(outcome).toEqual({ status: "no_token", ledgerId: "ledger-1" });
    expect(buildCalendarClient).not.toHaveBeenCalled();
  });

  it("created: happy path renews the lease, advances provider_done -> finalized, and stamps the task", async () => {
    const insert = vi.fn().mockResolvedValue({ data: { id: "evt-1" } });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [
        ledgerWrite(), // lease renewal after the Google call returns
        ledgerWrite(), // provider_done
        ledgerWrite(), // finalized
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
        ledgerWrite(), // lease renewal
        ledgerWrite(), // provider_done
        ledgerWrite(), // finalized
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
      task_calendar_mutations: [ledgerWrite()], // last_error update, stays pending
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(outcome.status).toBe("retryable_error");
  });

  it("finalize CAS: provider succeeds but the task's generation moved — leaves provider_done, never resurrects", async () => {
    const insert = vi.fn().mockResolvedValue({ data: { id: "evt-3" } });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [
        ledgerWrite(), // lease renewal
        ledgerWrite(), // provider_done write succeeds
      ],
      tasks: [{ data: null, error: null }], // CAS: 0 rows matched — generation moved
    });

    const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

    expect(outcome).toEqual({
      status: "finalize_conflict",
      ledgerId: "ledger-1",
      eventId: "evt-3",
    });
  });

  describe("round 7: fencing token / lease loss", () => {
    it("lease_lost: the retryable-failure write is a no-op when the claim_token was already reclaimed", async () => {
      const insert = vi.fn().mockRejectedValue({ status: 503, message: "backend error" });
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const supabase = fakeSupabase({
        // 0 rows: another worker already reclaimed this row's lease
        // (fresh claim_token) or moved it past 'pending' by the time this
        // write lands — this worker must abandon it silently, not error.
        task_calendar_mutations: [ledgerWrite(false)],
      });

      const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

      expect(outcome).toEqual({ status: "lease_lost", ledgerId: "ledger-1" });
    });

    it("lease_lost: the finalize write is a no-op — not an error — when the row was already finalized by the current owner", async () => {
      const insert = vi.fn().mockResolvedValue({ data: { id: "evt-4" } });
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const supabase = fakeSupabase({
        task_calendar_mutations: [
          ledgerWrite(), // lease renewal
          ledgerWrite(), // provider_done
          ledgerWrite(false), // finalize: 0 rows — WHERE phase='provider_done' no
          // longer matches (already finalized/reclaimed) — a finalized row can
          // never be re-written by this or any other transition.
        ],
        tasks: [{ data: { id: "task-1" }, error: null }],
      });

      const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

      expect(outcome).toEqual({ status: "lease_lost", ledgerId: "ledger-1" });
    });

    it("lease_lost: the permanent-failure write is a no-op when the token no longer matches", async () => {
      const insert = vi
        .fn()
        .mockRejectedValue({ status: 403, response: { data: { error: { errors: [{ reason: "insufficientPermissions" }] } } } });
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const supabase = fakeSupabase({
        task_calendar_mutations: [ledgerWrite(false)],
      });

      const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

      expect(outcome).toEqual({ status: "lease_lost", ledgerId: "ledger-1" });
    });
  });

  describe("round 7: structured Google error classification", () => {
    function insertRejecting(error: unknown) {
      const insert = vi.fn().mockRejectedValue(error);
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    }

    it("403 rateLimitExceeded retries", async () => {
      insertRejecting({
        status: 403,
        response: { data: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
      });
      const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

      const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

      expect(outcome.status).toBe("retryable_error");
    });

    it("403 insufficientPermissions is terminal", async () => {
      insertRejecting({
        status: 403,
        response: { data: { error: { errors: [{ reason: "insufficientPermissions" }] } } },
      });
      const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

      const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

      expect(outcome.status).toBe("permanent_error");
    });

    it("401 is terminal", async () => {
      insertRejecting({ status: 401, message: "invalid credentials" });
      const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

      const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

      expect(outcome.status).toBe("permanent_error");
    });

    it("an unrecognized 403 reason defaults to retryable (fail toward retry)", async () => {
      insertRejecting({
        status: 403,
        response: { data: { error: { errors: [{ reason: "somethingNeverSeenBefore" }] } } },
      });
      const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

      const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

      expect(outcome.status).toBe("retryable_error");
    });

    it("a bare 403 with no structured reason at all also defaults to retryable", async () => {
      insertRejecting({ status: 403, message: "forbidden" });
      const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

      const outcome = await processClaimedCalendarCreation(supabase, BASE_CLAIMED);

      expect(outcome.status).toBe("retryable_error");
    });
  });

  describe("provider_done resume (round 6 durable lease)", () => {
    const PROVIDER_DONE_CLAIMED: ClaimedCalendarCreationRow = {
      ...BASE_CLAIMED,
      attempts: 2,
      phase: "provider_done",
      new_event_id: "evt-resumed",
      result_reason: "event_created",
    };

    it("resumes without any insert call, using the recorded new_event_id", async () => {
      // A fresh, unused insert spy — proving the resume path never reaches
      // the point where it would call it, independent of buildCalendarClient's
      // call history from earlier tests in this file (mocks aren't reset
      // between tests here).
      const insert = vi.fn();
      const buildCalendarClientCallsBefore = vi.mocked(buildCalendarClient).mock.calls.length;
      const supabase = fakeSupabase({
        tasks: [{ data: { id: "task-1" }, error: null }], // finalize CAS success
        task_calendar_mutations: [ledgerWrite()], // finalized
      });

      const outcome = await processClaimedCalendarCreation(supabase, PROVIDER_DONE_CLAIMED);

      expect(insert).not.toHaveBeenCalled();
      expect(vi.mocked(buildCalendarClient).mock.calls.length).toBe(buildCalendarClientCallsBefore);
      expect(outcome).toEqual({ status: "created", ledgerId: "ledger-1", eventId: "evt-resumed" });
    });

    it("preserves reconciled_409 from the original attempt across the resume", async () => {
      const supabase = fakeSupabase({
        tasks: [{ data: { id: "task-1" }, error: null }],
        task_calendar_mutations: [ledgerWrite()],
      });

      const outcome = await processClaimedCalendarCreation(supabase, {
        ...PROVIDER_DONE_CLAIMED,
        result_reason: "reconciled_409",
      });

      expect(outcome).toEqual({
        status: "reconciled_409",
        ledgerId: "ledger-1",
        eventId: "evt-resumed",
      });
    });

    it("task-update failure recovers on a subsequent claim", async () => {
      const failingSupabase = fakeSupabase({
        tasks: [{ data: null, error: { message: "connection reset" } }],
        task_calendar_mutations: [ledgerWrite()], // markRetryableFailure's backoff write
      });
      const first = await processClaimedCalendarCreation(failingSupabase, PROVIDER_DONE_CLAIMED);
      expect(first.status).toBe("retryable_error");

      // Subsequent claim: same row, still provider_done (nothing about it
      // changed), this time the task CAS and finalize both succeed.
      const recoveredSupabase = fakeSupabase({
        tasks: [{ data: { id: "task-1" }, error: null }],
        task_calendar_mutations: [ledgerWrite()],
      });
      const second = await processClaimedCalendarCreation(
        recoveredSupabase,
        PROVIDER_DONE_CLAIMED,
      );
      expect(second).toEqual({ status: "created", ledgerId: "ledger-1", eventId: "evt-resumed" });
    });

    it("finalization failure recovers on a subsequent claim", async () => {
      const failingSupabase = fakeSupabase({
        tasks: [{ data: { id: "task-1" }, error: null }],
        task_calendar_mutations: [
          { data: null, error: { message: "deadlock detected" } }, // finalize update fails
          ledgerWrite(), // markRetryableFailure's backoff write
        ],
      });
      const first = await processClaimedCalendarCreation(failingSupabase, PROVIDER_DONE_CLAIMED);
      expect(first.status).toBe("retryable_error");

      const recoveredSupabase = fakeSupabase({
        tasks: [{ data: { id: "task-1" }, error: null }],
        task_calendar_mutations: [ledgerWrite()],
      });
      const second = await processClaimedCalendarCreation(
        recoveredSupabase,
        PROVIDER_DONE_CLAIMED,
      );
      expect(second).toEqual({ status: "created", ledgerId: "ledger-1", eventId: "evt-resumed" });
    });

    it("double-finalize: a concurrent worker finalizing first leaves this one with a clean lease_lost, not an error", async () => {
      const supabase = fakeSupabase({
        tasks: [{ data: { id: "task-1" }, error: null }],
        task_calendar_mutations: [ledgerWrite()],
      });
      const first = await processClaimedCalendarCreation(supabase, PROVIDER_DONE_CLAIMED);
      expect(first).toEqual({ status: "created", ledgerId: "ledger-1", eventId: "evt-resumed" });

      // Same row claimed again (e.g. a race with another sweep that
      // already finalized it) — the finalize update's
      // phase='provider_done' + claim_token filter now matches 0 rows
      // server-side (round 7): lease_lost, not a re-success and not an
      // error — the row belongs to whoever finalized it first.
      const secondSupabase = fakeSupabase({
        tasks: [{ data: { id: "task-1" }, error: null }],
        task_calendar_mutations: [ledgerWrite(false)],
      });
      const second = await processClaimedCalendarCreation(secondSupabase, PROVIDER_DONE_CLAIMED);
      expect(second).toEqual({ status: "lease_lost", ledgerId: "ledger-1" });
    });
  });
});
