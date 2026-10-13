import { reportError } from "@/lib/errors/report";

import { civilDateKey, localParts } from "./dialing-window";

// Plan [B21]: twice-daily org digest. Editions are inserted unconditionally inside their local windows
// (morning [08:45,09:15), evening [19:45,20:15) in NORMA_QUEUE_CAP_TZ); unique (org, local_date, edition) dedupes.
// Delivery is at-least-once: pending rows are claimed under a lease, retried with backoff, up to 8 attempts.

export const NORMA_QUEUE_DIGEST_MAX_ATTEMPTS = 8;
const LEASE_MS = 10 * 60_000;
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_CAP_MS = 6 * 60 * 60_000;

export type DigestEdition = "morning" | "evening";

export type DigestRow = {
  id: string;
  orgId: string;
  localDate: string;
  edition: string;
  payload: unknown;
  status: "pending" | "sent" | "failed";
  attempts: number;
  lockedUntil: string | null;
  nextAttemptAt: string | null;
  sentAt: string | null;
};

export type DigestStore = {
  listOrgIds: () => Promise<string[]>;
  dayActivity: (orgId: string, localDate: string) => Promise<{ activityCount: number; liveEntries: number }>;
  buildPayload: (orgId: string, localDate: string, edition: string) => Promise<unknown>;
  /** Returns false when the (org, local_date, edition) key already exists. */
  insertDigest: (digest: { orgId: string; localDate: string; edition: string; payload: unknown }) => Promise<boolean>;
  claimDue: (nowIso: string, leaseMs: number) => Promise<DigestRow[]>;
  markSent: (id: string, nowIso: string) => Promise<void>;
  markFailed: (id: string, failure: { error: string; attempts: number; nextAttemptAt: string | null; gaveUp: boolean }) => Promise<void>;
};

const MORNING = [8 * 60 + 45, 9 * 60 + 15] as const;
const EVENING = [19 * 60 + 45, 20 * 60 + 15] as const;

export function digestEditionFor(now: Date, tz: string): { edition: DigestEdition; localDate: string } | null {
  const p = localParts(now, tz);
  const minutes = p.hour * 60 + p.minute;
  const localDate = civilDateKey(p);
  if (minutes >= MORNING[0] && minutes < MORNING[1]) return { edition: "morning", localDate };
  if (minutes >= EVENING[0] && minutes < EVENING[1]) return { edition: "evening", localDate };
  return null;
}

export function digestBackoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
}

export async function runNormaQueueDigestTick(deps: {
  now: () => number;
  tz: string;
  store: DigestStore;
  post: (payload: unknown) => Promise<unknown>;
}): Promise<{ inserted: number; sent: number; failed: number }> {
  const { store, post } = deps;
  const nowMs = deps.now();
  const nowIso = new Date(nowMs).toISOString();
  let inserted = 0;
  let sent = 0;
  let failed = 0;

  const due = digestEditionFor(new Date(nowMs), deps.tz);
  if (due) {
    let orgIds: string[] = [];
    try {
      orgIds = await store.listOrgIds();
    } catch (err) {
      reportError(err, { route: "norma-queue-digest", extra: { step: "list_orgs" } } as never);
    }
    for (const orgId of orgIds) {
      try {
        const activity = due.edition === "evening" ? await store.dayActivity(orgId, due.localDate) : null;
        const built = await store.buildPayload(orgId, due.localDate, due.edition);
        const payload = activity && built && typeof built === "object" && !Array.isArray(built) ? { ...built, activity } : built;
        if (await store.insertDigest({ orgId, localDate: due.localDate, edition: due.edition, payload })) inserted += 1;
      } catch (err) {
        reportError(err, { route: "norma-queue-digest", extra: { step: "insert", orgId } } as never);
      }
    }
  }

  let rows: DigestRow[] = [];
  try {
    rows = await store.claimDue(nowIso, LEASE_MS);
  } catch (err) {
    reportError(err, { route: "norma-queue-digest", extra: { step: "claim" } } as never);
    return { inserted, sent, failed };
  }

  for (const row of rows) {
    try {
      await post(row.payload);
    } catch (err) {
      const attempts = row.attempts + 1;
      const gaveUp = attempts >= NORMA_QUEUE_DIGEST_MAX_ATTEMPTS;
      failed += 1;
      try {
        await store.markFailed(row.id, {
          error: err instanceof Error ? err.message : String(err),
          attempts,
          nextAttemptAt: gaveUp ? null : new Date(nowMs + digestBackoffMs(attempts)).toISOString(),
          gaveUp,
        });
      } catch (markErr) {
        reportError(markErr, { route: "norma-queue-digest", extra: { step: "mark_failed", id: row.id } } as never);
      }
      continue;
    }
    try {
      await store.markSent(row.id, nowIso);
      sent += 1;
    } catch (err) {
      // Posted but not recorded: the lease expires and the row is re-posted (at-least-once, duplicate accepted).
      reportError(err, { route: "norma-queue-digest", extra: { step: "mark_sent", id: row.id } } as never);
    }
  }
  return { inserted, sent, failed };
}
