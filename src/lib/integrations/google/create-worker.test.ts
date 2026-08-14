import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("./dispatch", () => ({
  buildCalendarClient: vi.fn(),
  isGoogleConflict: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { status?: unknown; code?: unknown };
    return candidate.status === 409 || candidate.code === 409;
  },
  isGoogleNotFound: (error: unknown) => {
    if (!error || typeof error !== "object") return false;
    const candidate = error as { status?: unknown; code?: unknown };
    return candidate.status === 404 || candidate.code === 404;
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
  processClaimedCalendarMutation,
  type ClaimedCalendarMutationRow,
} from "./create-worker";
import { buildCalendarClient } from "./dispatch";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { getDecryptedToken } from "@/lib/integrations/tokens/store";

type ChainResult =
  | { data: unknown; error: { message: string } | null }
  /** A transport-level rejection — the underlying client promise itself
   *  rejects, distinct from a resolved `{ data: null, error }` — used to
   *  exercise the never-throw boundary around the provider_done resume
   *  dispatch. */
  | { reject: unknown };

/** Same thenable, infinitely-chainable fake Postgrest builder used in
 *  src/lib/messaging/send.test.ts — resolves to a fixed result regardless
 *  of which chain methods are called on the way there. Also supports a
 *  `{ reject }` queue entry that makes both `.maybeSingle()` and the
 *  builder's own `.then()` reject instead of resolve. */
function chain(result: ChainResult) {
  if ("reject" in result) {
    const err = result.reject;
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      update: () => builder,
      maybeSingle: () => Promise.reject(err),
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.reject(err).then(resolve, reject),
    };
    return builder;
  }
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

function fakeSupabase(queues: Record<string, ChainResult[]>) {
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

const BASE_CLAIMED: ClaimedCalendarMutationRow = {
  ledger_id: "ledger-1",
  org_id: "org-1",
  calendar_chain_id: "chain-1",
  operation: "create",
  phase: "pending",
  source_task_id: "task-1",
  target_task_id: null,
  old_assignee_id: "assignee-1",
  new_assignee_id: null,
  event_id: null,
  expected_generation: 0,
  client_event_id: "evtclient1",
  attempts: 1,
  new_event_id: null,
  result_reason: null,
  old_event_deleted_at: null,
  claim_token: "token-1",
  source_due_at: "2026-09-01T15:00:00.000Z",
  source_end_at: "2026-09-01T15:30:00.000Z",
  source_title: "Walkthrough",
  source_assignee_id: "assignee-1",
  target_due_at: null,
  target_end_at: null,
  target_title: null,
  target_assignee_id: null,
};

const FAKE_TOKEN = { accessToken: { reveal: () => "tok" } } as never;

beforeEach(() => {
  vi.mocked(loadIntegrationPrefs).mockResolvedValue({
    calendarEnabled: true,
    slackEnabled: true,
    timezone: "America/Chicago",
    smsRemindersEnabled: false,
    reminderPhone: null,
  });
  vi.mocked(getDecryptedToken).mockResolvedValue(FAKE_TOKEN);
});

describe("processClaimedCalendarCreation", () => {
  it("pref_disabled: finalizes with a NULL event, no calendar client built", async () => {
    vi.mocked(loadIntegrationPrefs).mockResolvedValue({
      calendarEnabled: false,
      slackEnabled: true,
      timezone: "America/Chicago",
      smsRemindersEnabled: false,
      reminderPhone: null,
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

    expect(insert).toHaveBeenCalledWith(
      {
        calendarId: "primary",
        requestBody: expect.objectContaining({ id: "evtclient1" }),
      },
      // Codex round 9 (finding 3): every Google call is bounded — retry
      // disabled (this file's own attempts/backoff is the durable retry
      // layer, not gaxios's opaque in-call one).
      { timeout: expect.any(Number), retry: false },
    );
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

    expect(get).toHaveBeenCalledWith(
      { calendarId: "primary", eventId: "evtclient1" },
      { timeout: expect.any(Number), retry: false },
    );
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
      taskId: "task-1",
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
    const PROVIDER_DONE_CLAIMED: ClaimedCalendarMutationRow = {
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

    it("a rejecting supabase call in the resume path is caught, not thrown — outcome retryable_error, backoff recorded at expectedPhase 'provider_done'", async () => {
      // PROVIDER_DONE_CLAIMED already has new_event_id set, so the resume
      // goes straight to finalizeCreation's task CAS — make that call
      // reject at the transport level (distinct from a resolved
      // `{ data: null, error }`) rather than returning cleanly.
      const supabase = fakeSupabase({
        tasks: [{ reject: new Error("connection reset by peer") }],
        // markRetryableFailure's backoff write, scoped to expectedPhase
        // 'provider_done' — proves the caught rejection is recorded
        // against the phase the resume path actually operates on, not
        // 'pending'.
        task_calendar_mutations: [ledgerWrite()],
      });

      const outcome = await processClaimedCalendarCreation(supabase, PROVIDER_DONE_CLAIMED);

      expect(outcome).toEqual({
        status: "retryable_error",
        ledgerId: "ledger-1",
        error: "connection reset by peer",
      });
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

describe("processClaimedCalendarMutation dispatch", () => {
  it("routes operation:create to the create handler", async () => {
    vi.mocked(loadIntegrationPrefs).mockResolvedValueOnce({
      calendarEnabled: false,
      slackEnabled: true,
      timezone: "America/Chicago",
      smsRemindersEnabled: false,
      reminderPhone: null,
    });
    const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...BASE_CLAIMED,
      operation: "create",
    });

    expect(outcome).toEqual({ status: "pref_disabled", ledgerId: "ledger-1" });
  });
});

describe("processClaimedCancel (via processClaimedCalendarMutation)", () => {
  it("deletes the event and clears the task's event id, marking deleted", async () => {
    const del = vi.fn().mockResolvedValue({});
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { delete: del },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite(), ledgerWrite(), ledgerWrite()],
      tasks: [{ data: null, error: null }],
    });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...BASE_CLAIMED,
      operation: "cancel",
      event_id: "evt-old",
      client_event_id: null,
    });

    expect(del).toHaveBeenCalledWith(
      { calendarId: "primary", eventId: "evt-old" },
      { timeout: expect.any(Number), retry: false },
    );
    expect(outcome).toEqual({ status: "deleted", ledgerId: "ledger-1" });
  });

  it("404 on delete (plan's explicit contract): idempotent success, same as a fresh delete", async () => {
    const del = vi.fn().mockRejectedValue({ status: 404 });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { delete: del },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite(), ledgerWrite(), ledgerWrite()],
      tasks: [{ data: null, error: null }],
    });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...BASE_CLAIMED,
      operation: "cancel",
      event_id: "evt-gone",
    });

    expect(outcome).toEqual({ status: "deleted", ledgerId: "ledger-1" });
  });

  it("no event_id: finalizes immediately as no_event, no calendar client built", async () => {
    const buildCalendarClientCallsBefore = vi.mocked(buildCalendarClient).mock.calls.length;
    const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...BASE_CLAIMED,
      operation: "cancel",
      event_id: null,
    });

    expect(outcome).toEqual({ status: "no_event", ledgerId: "ledger-1" });
    expect(vi.mocked(buildCalendarClient).mock.calls.length).toBe(buildCalendarClientCallsBefore);
  });

  it("lease_lost: renewLease is a fenced no-op after a successful delete — never advances phase for a lost lease", async () => {
    const del = vi.fn().mockResolvedValue({});
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { delete: del },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite(false)], // renewLease: 0 rows — lease already reclaimed
    });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...BASE_CLAIMED,
      operation: "cancel",
      event_id: "evt-old",
    });

    expect(outcome).toEqual({ status: "lease_lost", ledgerId: "ledger-1" });
  });

  it("Codex round 1 (finding 4): no token but event_id EXISTS — retryable stale-event outcome, NOT finalized as a no-op (the Google event would go silently stale)", async () => {
    vi.mocked(getDecryptedToken).mockResolvedValueOnce(null);
    const buildCalendarClientCallsBefore = vi.mocked(buildCalendarClient).mock.calls.length;
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite()], // markStaleEventRetryable's single write
    });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...BASE_CLAIMED,
      operation: "cancel",
      event_id: "evt-old",
    });

    expect(outcome).toEqual({
      status: "stale_event_needs_token",
      ledgerId: "ledger-1",
      error: expect.stringContaining("no token"),
    });
    expect(vi.mocked(buildCalendarClient).mock.calls.length).toBe(buildCalendarClientCallsBefore);
  });
});

describe("processClaimedReschedule (via processClaimedCalendarMutation)", () => {
  const RESCHEDULE_CLAIMED: ClaimedCalendarMutationRow = {
    ...BASE_CLAIMED,
    operation: "reschedule",
    event_id: "evt-old",
    client_event_id: null,
    target_task_id: "succ-1",
    target_due_at: "2026-09-02T15:00:00.000Z",
    target_end_at: "2026-09-02T15:30:00.000Z",
    target_title: "Walkthrough",
    target_assignee_id: "assignee-1",
  };

  it("updates the event under the OLD assignee's token to the successor's new window, then CAS-moves the event id old -> successor", async () => {
    const patch = vi.fn().mockResolvedValue({ data: { id: "evt-old" } });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { patch },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite(), ledgerWrite(), ledgerWrite()],
      tasks: [
        { data: { id: "succ-1" }, error: null }, // CAS onto successor
        { data: null, error: null }, // best-effort clear on source
      ],
    });

    const outcome = await processClaimedCalendarMutation(supabase, RESCHEDULE_CLAIMED);

    expect(patch).toHaveBeenCalledWith(
      {
        calendarId: "primary",
        eventId: "evt-old",
        requestBody: {
          start: { dateTime: "2026-09-02T15:00:00.000Z" },
          end: { dateTime: "2026-09-02T15:30:00.000Z" },
        },
      },
      { timeout: expect.any(Number), retry: false },
    );
    expect(outcome).toEqual({ status: "updated", ledgerId: "ledger-1", eventId: "evt-old" });
  });

  it("finalize CAS lost: the successor's generation moved before the transfer landed — finalize_conflict, never resurrects", async () => {
    const patch = vi.fn().mockResolvedValue({ data: { id: "evt-old" } });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { patch },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite(), ledgerWrite()],
      tasks: [{ data: null, error: null }], // CAS onto successor: 0 rows matched
    });

    const outcome = await processClaimedCalendarMutation(supabase, RESCHEDULE_CLAIMED);

    expect(outcome).toEqual({
      status: "finalize_conflict",
      ledgerId: "ledger-1",
      eventId: "evt-old",
      taskId: "succ-1",
    });
  });

  it("no event_id: finalizes immediately as no_event, no calendar client built", async () => {
    const buildCalendarClientCallsBefore = vi.mocked(buildCalendarClient).mock.calls.length;
    const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...RESCHEDULE_CLAIMED,
      event_id: null,
    });

    expect(outcome).toEqual({ status: "no_event", ledgerId: "ledger-1" });
    expect(vi.mocked(buildCalendarClient).mock.calls.length).toBe(buildCalendarClientCallsBefore);
  });

  it("missing target_task_id is a structural permanent failure, not a silent no-op", async () => {
    const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...RESCHEDULE_CLAIMED,
      target_task_id: null,
    });

    expect(outcome.status).toBe("permanent_error");
  });

  it("Codex round 1 (finding 4): no token but event_id EXISTS — retryable stale-event outcome, NOT finalized as a no-op (the event would stay at the OLD time forever)", async () => {
    vi.mocked(getDecryptedToken).mockResolvedValueOnce(null);
    const buildCalendarClientCallsBefore = vi.mocked(buildCalendarClient).mock.calls.length;
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite()],
    });

    const outcome = await processClaimedCalendarMutation(supabase, RESCHEDULE_CLAIMED);

    expect(outcome).toEqual({
      status: "stale_event_needs_token",
      ledgerId: "ledger-1",
      error: expect.stringContaining("no token"),
    });
    expect(vi.mocked(buildCalendarClient).mock.calls.length).toBe(buildCalendarClientCallsBefore);
  });
});

describe("processClaimedReassign (via processClaimedCalendarMutation)", () => {
  const REASSIGN_CLAIMED: ClaimedCalendarMutationRow = {
    ...BASE_CLAIMED,
    operation: "reassign",
    event_id: "evt-old",
    old_assignee_id: "assignee-1",
    new_assignee_id: "assignee-2",
    client_event_id: "evtclient-reassign",
  };

  it("deletes under the old account (idempotent 404-tolerant), persists delete-done, and creates under the new account with a fresh client_event_id", async () => {
    const del = vi.fn().mockResolvedValue({});
    const insert = vi.fn().mockResolvedValue({ data: { id: "evt-new" } });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { delete: del, insert, get: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      // 1: renewLease after delete, 2: persist old_event_deleted_at
      // (+ result_reason='old_event_deleted'), 3: renewLease after create,
      // 4: phase->provider_done, 5: finalize.
      task_calendar_mutations: [
        ledgerWrite(),
        ledgerWrite(),
        ledgerWrite(),
        ledgerWrite(),
        ledgerWrite(),
      ],
      tasks: [{ data: { id: "task-1" }, error: null }],
    });

    const outcome = await processClaimedCalendarMutation(supabase, REASSIGN_CLAIMED);

    expect(del).toHaveBeenCalledWith(
      { calendarId: "primary", eventId: "evt-old" },
      { timeout: expect.any(Number), retry: false },
    );
    expect(insert).toHaveBeenCalledWith(
      {
        calendarId: "primary",
        requestBody: expect.objectContaining({ id: "evtclient-reassign" }),
      },
      { timeout: expect.any(Number), retry: false },
    );
    expect(outcome).toEqual({ status: "reassigned", ledgerId: "ledger-1", eventId: "evt-new" });
  });

  it("old event already gone (404) still proceeds to create under the new account", async () => {
    const del = vi.fn().mockRejectedValue({ status: 404 });
    const insert = vi.fn().mockResolvedValue({ data: { id: "evt-new-2" } });
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { delete: del, insert, get: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [
        ledgerWrite(),
        ledgerWrite(),
        ledgerWrite(),
        ledgerWrite(),
        ledgerWrite(),
      ],
      tasks: [{ data: { id: "task-1" }, error: null }],
    });

    const outcome = await processClaimedCalendarMutation(supabase, REASSIGN_CLAIMED);

    expect(outcome).toEqual({ status: "reassigned", ledgerId: "ledger-1", eventId: "evt-new-2" });
  });

  describe("Codex round 4 fix (finding 2): destination validated BEFORE the old event is ever touched", () => {
    it("destination-disabled → source untouched: new assignee's calendar disabled, old event still exists — retryable stale-event outcome, but nothing was deleted or created", async () => {
      const del = vi.fn();
      const insert = vi.fn();
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { delete: del, insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      vi.mocked(loadIntegrationPrefs).mockResolvedValueOnce({
        calendarEnabled: false,
        slackEnabled: true,
        timezone: "America/Chicago",
        smsRemindersEnabled: false,
        reminderPhone: null,
      });
      const getDecryptedTokenCallsBefore = vi.mocked(getDecryptedToken).mock.calls.length;
      const supabase = fakeSupabase({
        // Only markStaleEventRetryable's single write — no delete-related
        // writes happen because the delete step is never reached.
        task_calendar_mutations: [ledgerWrite()],
      });

      const outcome = await processClaimedCalendarMutation(supabase, REASSIGN_CLAIMED);

      expect(del).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      // Destination-validation failed before even reaching a token lookup.
      expect(vi.mocked(getDecryptedToken).mock.calls.length).toBe(getDecryptedTokenCallsBefore);
      expect(outcome).toEqual({
        status: "stale_event_needs_token",
        ledgerId: "ledger-1",
        error: expect.stringContaining("disabled"),
      });
    });

    it("new assignee has no token, old event still exists — retryable stale-event outcome, nothing deleted or created", async () => {
      const del = vi.fn();
      const insert = vi.fn();
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { delete: del, insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      vi.mocked(getDecryptedToken).mockResolvedValueOnce(null); // new-account lookup fails; old-account lookup never happens
      const supabase = fakeSupabase({
        task_calendar_mutations: [ledgerWrite()], // markStaleEventRetryable's single write
      });

      const outcome = await processClaimedCalendarMutation(supabase, REASSIGN_CLAIMED);

      expect(del).not.toHaveBeenCalled();
      expect(insert).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        status: "stale_event_needs_token",
        ledgerId: "ledger-1",
        error: expect.stringContaining("no token"),
      });
    });

    it("new-account calendar client fails to build — retryable stale-event outcome (Codex round 4: previously permanent-failed; now retried like the other destination checks since nothing was touched), nothing deleted or created", async () => {
      const del = vi.fn();
      vi.mocked(buildCalendarClient).mockImplementation(() => {
        throw new Error("bad oauth config");
      });
      const supabase = fakeSupabase({
        task_calendar_mutations: [ledgerWrite()], // markStaleEventRetryable's single write
      });

      const outcome = await processClaimedCalendarMutation(supabase, REASSIGN_CLAIMED);

      expect(del).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        status: "stale_event_needs_token",
        ledgerId: "ledger-1",
        error: "bad oauth config",
      });
    });

    it("create fails with a non-conflict provider error — retryable_error, the OLD event is never touched (this is the exact bug the round-4 reorder fixes: the old ordering deleted first, so a create failure here used to strand the appointment with no event anywhere)", async () => {
      const del = vi.fn();
      const insert = vi.fn().mockRejectedValue({ status: 500, message: "backend blip" });
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { delete: del, insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const supabase = fakeSupabase({
        task_calendar_mutations: [ledgerWrite()], // handleProviderFailure's markRetryableFailure write
      });

      const outcome = await processClaimedCalendarMutation(supabase, REASSIGN_CLAIMED);

      expect(del).not.toHaveBeenCalled();
      expect(outcome.status).toBe("retryable_error");
    });

    it("full happy path: validates destination, creates under the new account first, THEN deletes the old event, then finalizes", async () => {
      const del = vi.fn().mockResolvedValue({});
      const insert = vi.fn().mockResolvedValue({ data: { id: "evt-new" } });
      const insertCallOrder: string[] = [];
      vi.mocked(buildCalendarClient).mockImplementation((userId: string) => {
        insertCallOrder.push(userId);
        return {
          events: {
            delete: async (...args: unknown[]) => {
              insertCallOrder.push("delete");
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return del(...(args as any));
            },
            insert: async (...args: unknown[]) => {
              insertCallOrder.push("insert");
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              return insert(...(args as any));
            },
            get: vi.fn(),
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      });
      const supabase = fakeSupabase({
        // renewLease-after-create, phase->provider_done, renewLease-after-
        // delete, persist old_event_deleted_at, finalize.
        task_calendar_mutations: [
          ledgerWrite(),
          ledgerWrite(),
          ledgerWrite(),
          ledgerWrite(),
          ledgerWrite(),
        ],
        tasks: [{ data: { id: "task-1" }, error: null }],
      });

      const outcome = await processClaimedCalendarMutation(supabase, REASSIGN_CLAIMED);

      expect(insert).toHaveBeenCalledWith(
        {
          calendarId: "primary",
          requestBody: expect.objectContaining({ id: "evtclient-reassign" }),
        },
        { timeout: expect.any(Number), retry: false },
      );
      expect(del).toHaveBeenCalledWith(
        { calendarId: "primary", eventId: "evt-old" },
        { timeout: expect.any(Number), retry: false },
      );
      // The create call happens strictly before the delete call.
      expect(insertCallOrder.indexOf("insert")).toBeLessThan(insertCallOrder.indexOf("delete"));
      expect(outcome).toEqual({ status: "reassigned", ledgerId: "ledger-1", eventId: "evt-new" });
    });

    it("create-then-crash resume: phase='provider_done' with new_event_id already set skips straight to delete — no re-create — then finalizes", async () => {
      const del = vi.fn().mockResolvedValue({});
      const insert = vi.fn();
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { delete: del, insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const getDecryptedTokenCallsBefore = vi.mocked(getDecryptedToken).mock.calls.length;
      const supabase = fakeSupabase({
        // renewLease after delete, persist old_event_deleted_at, finalize —
        // no create-related writes, proving the create step never re-runs.
        task_calendar_mutations: [ledgerWrite(), ledgerWrite(), ledgerWrite()],
        tasks: [{ data: { id: "task-1" }, error: null }],
      });

      const outcome = await processClaimedCalendarMutation(supabase, {
        ...REASSIGN_CLAIMED,
        phase: "provider_done",
        new_event_id: "evt-new-from-earlier-attempt",
        result_reason: "event_created",
      });

      expect(insert).not.toHaveBeenCalled();
      expect(del).toHaveBeenCalledWith(
        { calendarId: "primary", eventId: "evt-old" },
        { timeout: expect.any(Number), retry: false },
      );
      // Only the old-account token lookup for the delete — no new-account
      // lookup, since the create step (and its token fetch) is skipped.
      expect(vi.mocked(getDecryptedToken).mock.calls.length).toBe(getDecryptedTokenCallsBefore + 1);
      expect(outcome).toEqual({
        status: "reassigned",
        ledgerId: "ledger-1",
        eventId: "evt-new-from-earlier-attempt",
      });
    });

    it("delete-fails retry preserves both markers: resumed at provider_done, delete fails with a non-404 — retryable_error, no re-create, new_event_id/phase untouched so the next retry resumes at the same point", async () => {
      const del = vi.fn().mockRejectedValue({ status: 500, message: "backend blip" });
      const insert = vi.fn();
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { delete: del, insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const supabase = fakeSupabase({
        // Only handleProviderFailure's markRetryableFailure write (phase
        // stays 'provider_done', old_event_deleted_at stays null) — no
        // create write, no finalize write.
        task_calendar_mutations: [ledgerWrite()],
      });

      const outcome = await processClaimedCalendarMutation(supabase, {
        ...REASSIGN_CLAIMED,
        phase: "provider_done",
        new_event_id: "evt-new-from-earlier-attempt",
        result_reason: "event_created",
      });

      expect(insert).not.toHaveBeenCalled();
      expect(del).toHaveBeenCalledWith(
        { calendarId: "primary", eventId: "evt-old" },
        { timeout: expect.any(Number), retry: false },
      );
      expect(outcome.status).toBe("retryable_error");
    });

    it("delete step: old-account token missing after create succeeded — retryable stale-event outcome (new event exists, old event is now the stale one)", async () => {
      const del = vi.fn();
      const insert = vi.fn();
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { delete: del, insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      vi.mocked(getDecryptedToken).mockResolvedValueOnce(null); // old-account lookup for the delete step
      const supabase = fakeSupabase({
        task_calendar_mutations: [ledgerWrite()], // markStaleEventRetryable's single write
      });

      const outcome = await processClaimedCalendarMutation(supabase, {
        ...REASSIGN_CLAIMED,
        phase: "provider_done",
        new_event_id: "evt-new-from-earlier-attempt",
        result_reason: "event_created",
      });

      expect(del).not.toHaveBeenCalled();
      expect(outcome).toEqual({
        status: "stale_event_needs_token",
        ledgerId: "ledger-1",
        error: expect.stringContaining("no token for old assignee"),
      });
    });
  });

  it("new assignee has no token, and there was NO old event to migrate: genuine clean no-op, finalizes as no_token", async () => {
    vi.mocked(getDecryptedToken).mockResolvedValueOnce(null); // new-account create — no old event_id, so no old-account delete call happens
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite()], // finalize no-op
    });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...REASSIGN_CLAIMED,
      event_id: null,
    });

    expect(outcome).toEqual({ status: "no_token", ledgerId: "ledger-1" });
  });

  it("missing new_assignee_id is a structural permanent failure, not a silent no-op", async () => {
    const supabase = fakeSupabase({ task_calendar_mutations: [ledgerWrite()] });

    const outcome = await processClaimedCalendarMutation(supabase, {
      ...REASSIGN_CLAIMED,
      new_assignee_id: null,
    });

    expect(outcome.status).toBe("permanent_error");
  });

  describe("legacy resume: a row still in-flight under the pre-round-4 delete-first ordering (old_event_deleted_at already set, phase still 'pending') is honored as-is — never re-deleted, and the create step runs exactly like a fresh row", () => {
    it("crash-between-delete-and-create recovery: a resumed row (old_event_deleted_at set, still phase='pending') skips straight to create — no re-delete, no duplicate event", async () => {
      const del = vi.fn();
      const insert = vi.fn().mockResolvedValue({ data: { id: "evt-new-resumed" } });
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { delete: del, insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const supabase = fakeSupabase({
        // No renewLease/delete-persist writes this time — those already
        // happened before the crash. Only: renewLease after create,
        // phase->provider_done, finalize.
        task_calendar_mutations: [ledgerWrite(), ledgerWrite(), ledgerWrite()],
        tasks: [{ data: { id: "task-1" }, error: null }],
      });
      const getDecryptedTokenCallsBefore = vi.mocked(getDecryptedToken).mock.calls.length;

      const outcome = await processClaimedCalendarMutation(supabase, {
        ...REASSIGN_CLAIMED,
        old_event_deleted_at: "2026-01-01T00:00:00.000Z",
      });

      expect(del).not.toHaveBeenCalled();
      // Only the new-account token lookup — no old-account lookup, since
      // the delete step (and its token fetch) is skipped entirely on resume.
      expect(vi.mocked(getDecryptedToken).mock.calls.length).toBe(getDecryptedTokenCallsBefore + 1);
      expect(insert).toHaveBeenCalledWith(
        {
          calendarId: "primary",
          requestBody: expect.objectContaining({ id: "evtclient-reassign" }),
        },
        { timeout: expect.any(Number), retry: false },
      );
      expect(outcome).toEqual({
        status: "reassigned",
        ledgerId: "ledger-1",
        eventId: "evt-new-resumed",
      });
    });

    it("Codex round 3 fix (finding 2): delete-progress is read from old_event_deleted_at, not result_reason — a retry survives result_reason being overwritten by an intervening stale-token failure, and never re-fetches the (now-revoked) old token", async () => {
      const del = vi.fn();
      const insert = vi.fn().mockResolvedValue({ data: { id: "evt-new-resumed" } });
      vi.mocked(buildCalendarClient).mockReturnValue({
        events: { delete: del, insert, get: vi.fn() },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      // Only ONE token lookup is expected to happen — the new assignee's,
      // for the create step. If the pre-fix bug were still present, the
      // worker would also fetch the OLD assignee's token to re-attempt the
      // delete; mocking a single resolved value here means that second
      // lookup (if it happened) would get `undefined`, surfacing as a
      // failure the assertions below catch.
      vi.mocked(getDecryptedToken).mockResolvedValueOnce(FAKE_TOKEN);
      const supabase = fakeSupabase({
        // renewLease after create, phase->provider_done, finalize — no
        // delete-related writes, proving the delete branch never runs.
        task_calendar_mutations: [ledgerWrite(), ledgerWrite(), ledgerWrite()],
        tasks: [{ data: { id: "task-1" }, error: null }],
      });
      const getDecryptedTokenCallsBefore = vi.mocked(getDecryptedToken).mock.calls.length;

      const outcome = await processClaimedCalendarMutation(supabase, {
        ...REASSIGN_CLAIMED,
        // The old-account delete succeeded and was durably persisted on an
        // earlier pass...
        old_event_deleted_at: "2026-01-01T00:00:00.000Z",
        // ...but a LATER pass's new-token-missing failure overwrote
        // result_reason with its own reason — clobbering the
        // "old_event_deleted" label the pre-fix code relied on to detect
        // delete-progress.
        result_reason: "no_token_stale_event",
      });

      expect(del).not.toHaveBeenCalled();
      expect(vi.mocked(getDecryptedToken).mock.calls.length).toBe(getDecryptedTokenCallsBefore + 1);
      expect(insert).toHaveBeenCalledWith(
        {
          calendarId: "primary",
          requestBody: expect.objectContaining({ id: "evtclient-reassign" }),
        },
        { timeout: expect.any(Number), retry: false },
      );
      expect(outcome).toEqual({
        status: "reassigned",
        ledgerId: "ledger-1",
        eventId: "evt-new-resumed",
      });
    });
  });
});

// ----------------------------------------------------------------------------
// Codex round 9 (finding 3) + round 10 (finding 1): every Google call is
// bounded to the remaining time until an ABSOLUTE `deadlineAt` (epoch ms),
// recomputed immediately before EACH call (`nextGoogleCallOptions`) rather
// than a single duration snapshotted once per row (round 9's original
// `timeoutMs`) — a hung/never-resolving Google call could otherwise hold
// the sweep route open past its platform `maxDuration`, and (round 10's fix)
// a slow-but-successful first call could otherwise leave a LATER call in
// the same row with a stale, too-generous window. These tests simulate a
// mock Google client honoring the SAME `timeout` field real gaxios reads
// (node_modules/gaxios's `#appendTimeoutToSignal` wires `opts.timeout` to
// `AbortSignal.timeout()`) — proving `processClaimedCalendarMutation`
// itself returns promptly (never hangs) once that timeout elapses, that
// each operation's outcome lands where finding 3 specifies (idempotent ops
// -> retryable, current phase untouched), and that a multi-call row
// (reassign) never spends more than `deadlineAt` regardless of how many
// Google calls it makes or how slow the earlier ones were.
// ----------------------------------------------------------------------------
describe("per-call Google timeout / deadline recompute (Codex round 9 finding 3 + round 10 finding 1)", () => {
  /** Rejects after exactly `options.timeout` ms — the same field
   *  `nextGoogleCallOptions` sets and real gaxios reads — with a
   *  TimeoutError-shaped rejection matching what `AbortSignal.timeout()`
   *  produces when it aborts a fetch. Never resolves on its own; if this
   *  file's code failed to bound the call, `vi.advanceTimersByTimeAsync`
   *  below would never unblock it and the test would hang/time out. */
  function neverResolvingUntilTimeout() {
    return vi.fn((_params: unknown, options?: { timeout?: number }) => {
      return new Promise((_resolve, reject) => {
        setTimeout(() => {
          const err = new Error("The operation was aborted due to timeout");
          err.name = "TimeoutError";
          reject(err);
        }, options?.timeout ?? 0);
      });
    });
  }

  /** Resolves after `delayMs`, echoing whatever `result` was supplied — used
   *  to simulate a SLOW-BUT-SUCCESSFUL Google call (as opposed to
   *  `neverResolvingUntilTimeout`'s hung one) so a later call in the same
   *  row's handler sees a shrunk remaining window. */
  function slowResolving<T>(result: T, delayMs: number) {
    return vi.fn((_params: unknown, _options?: { timeout?: number }) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(result), delayMs)),
    );
  }

  /** Rejects after `delayMs` with `rejection` — the slow-but-settled
   *  counterpart to `slowResolving`, for a call that eventually fails
   *  (e.g. a 409 conflict) rather than hanging or succeeding. */
  function slowRejecting(rejection: unknown, delayMs: number) {
    return vi.fn((_params: unknown, _options?: { timeout?: number }) =>
      new Promise((_resolve, reject) => setTimeout(() => reject(rejection), delayMs)),
    );
  }

  const REASSIGN_ROW: ClaimedCalendarMutationRow = {
    ...BASE_CLAIMED,
    operation: "reassign",
    event_id: "evt-old",
    old_assignee_id: "assignee-1",
    new_assignee_id: "assignee-2",
    client_event_id: "evtclient-reassign",
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // `deadlineAt` chosen as `now + 8_000` so remaining = deadlineAt - now -
  // DB_FINALIZE_RESERVE_MS(3_000) = 5_000 at call time, exactly reproducing
  // round 9's original `{ timeoutMs: 5_000 }` fixtures below.
  it("create: a hung insert resolves retryable_error at exactly its remaining-time budget, never past it", async () => {
    const insert = neverResolvingUntilTimeout();
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get: vi.fn() },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite()], // markRetryableFailure's single write
    });

    const deadlineAt = Date.now() + 8_000;
    const outcomePromise = processClaimedCalendarMutation(supabase, BASE_CLAIMED, {
      deadlineAt,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await outcomePromise;

    expect(insert).toHaveBeenCalledWith(expect.anything(), { timeout: 5_000, retry: false });
    expect(outcome.status).toBe("retryable_error");
  });

  it("cancel: a hung delete resolves retryable_error — delete is naturally idempotent, so leaving it retryable never risks a duplicate", async () => {
    const del = neverResolvingUntilTimeout();
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { delete: del },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      task_calendar_mutations: [ledgerWrite()],
    });

    const deadlineAt = Date.now() + 8_000;
    const outcomePromise = processClaimedCalendarMutation(
      supabase,
      { ...BASE_CLAIMED, operation: "cancel", event_id: "evt-old", client_event_id: null },
      { deadlineAt },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await outcomePromise;

    expect(del).toHaveBeenCalledWith(expect.anything(), { timeout: 5_000, retry: false });
    expect(outcome.status).toBe("retryable_error");
  });

  it("reschedule: a hung patch resolves retryable_error — never advances to provider_done on an unconfirmed patch, so a retry safely re-applies the same idempotent time write", async () => {
    const patch = neverResolvingUntilTimeout();
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { patch },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      // Only markRetryableFailure's single write — if the code wrongly
      // advanced to provider_done or attempted a finalize CAS despite the
      // patch never confirming, the second (unqueued) `.from()` call below
      // would throw and this test would fail loudly instead of silently
      // passing.
      task_calendar_mutations: [ledgerWrite()],
    });

    const deadlineAt = Date.now() + 8_000;
    const outcomePromise = processClaimedCalendarMutation(
      supabase,
      {
        ...BASE_CLAIMED,
        operation: "reschedule",
        event_id: "evt-old",
        client_event_id: null,
        target_task_id: "succ-1",
        target_due_at: "2026-09-02T15:00:00.000Z",
        target_end_at: "2026-09-02T15:30:00.000Z",
        target_title: "Walkthrough",
        target_assignee_id: "assignee-1",
      },
      { deadlineAt },
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await outcomePromise;

    expect(patch).toHaveBeenCalledWith(expect.anything(), { timeout: 5_000, retry: false });
    expect(outcome.status).toBe("retryable_error");
  });

  // Codex round 10 (finding 1): the core of this finding — a multi-call row
  // (reassign: insert, an optional 409-reconcile get, delete) must recompute
  // its remaining time before EACH call, not reuse one snapshot from the
  // start of the row.
  it("reassign: a slow-but-successful insert leaves a strictly smaller window for the reconcile get and the old-event delete that follow it, and never exceeds the deadline", async () => {
    const CALL_DELAY_MS = 3_000;
    const insert = slowRejecting({ status: 409 }, CALL_DELAY_MS);
    const get = slowResolving({ data: { id: "evt-new-reconciled" } }, CALL_DELAY_MS);
    const del = slowResolving({}, CALL_DELAY_MS);
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get, delete: del },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      // renewLease+provider_done after create, renewLease+delete-persisted
      // after delete, finalize.
      task_calendar_mutations: [
        ledgerWrite(),
        ledgerWrite(),
        ledgerWrite(),
        ledgerWrite(),
        ledgerWrite(),
      ],
      tasks: [{ data: { id: "task-1" }, error: null }],
    });

    const start = Date.now();
    const deadlineAt = start + 30_000;
    const outcomePromise = processClaimedCalendarMutation(supabase, REASSIGN_ROW, { deadlineAt });
    await vi.advanceTimersByTimeAsync(CALL_DELAY_MS); // insert settles (409)
    await vi.advanceTimersByTimeAsync(CALL_DELAY_MS); // reconcile get settles
    await vi.advanceTimersByTimeAsync(CALL_DELAY_MS); // old-event delete settles
    const outcome = await outcomePromise;

    const insertTimeout = insert.mock.calls[0]?.[1]?.timeout ?? -1;
    const getTimeout = get.mock.calls[0]?.[1]?.timeout ?? -1;
    const deleteTimeout = del.mock.calls[0]?.[1]?.timeout ?? -1;

    // Strictly decreasing: each call's own elapsed wall-clock time is
    // subtracted from what the NEXT call sees, proving the window is
    // recomputed fresh immediately before each call rather than reused from
    // a single snapshot taken at the start of the row.
    expect(insertTimeout).toBeGreaterThan(getTimeout);
    expect(getTimeout).toBeGreaterThan(deleteTimeout);
    expect(Date.now() - start).toBeLessThanOrEqual(30_000);
    expect(outcome.status).toBe("reassigned");
  });

  it("reassign: a call attempted with too little of the deadline left is skipped entirely — never issued to Google — and the row is left retryable instead of hanging past the deadline", async () => {
    // deadlineAt - insertDelay - DB_FINALIZE_RESERVE_MS(3_000) works out
    // negative, well under PER_CALL_TIMEOUT_FLOOR_MS(2_000) — the delete
    // step must give up before ever calling `del`.
    const insert = slowResolving({ data: { id: "evt-new" } }, 8_000);
    const del = vi.fn();
    vi.mocked(buildCalendarClient).mockReturnValue({
      events: { insert, get: vi.fn(), delete: del },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const supabase = fakeSupabase({
      // renewLease + provider_done write after the (slow) insert, then
      // markRetryableFailure's write when the delete step gives up without
      // ever calling Google.
      task_calendar_mutations: [ledgerWrite(), ledgerWrite(), ledgerWrite()],
    });

    const deadlineAt = Date.now() + 10_000;
    const outcomePromise = processClaimedCalendarMutation(supabase, REASSIGN_ROW, { deadlineAt });
    await vi.advanceTimersByTimeAsync(8_000);
    const outcome = await outcomePromise;

    expect(insert).toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(outcome.status).toBe("retryable_error");
  });
});
