/**
 * The client state machine for Messages v2 (see the "Client state machine" table in PR #874).
 *
 * Every async result that touches per-card or per-run state is committed through `commitIfCurrent`, which discards
 * anything stale. Per-card check state is one record per card; whether a card's actions are enabled is decided in
 * ONE place (`actionsEnabled`). These functions are pure so every out-of-order interleaving can be tested directly.
 *
 * Rules:
 *  R-A  A card's actions are enabled only from that card's OWN last successful check in the current snapshot.
 *  R-B  A result commits only if its (snapshot key, card/run id, version, seq) is still current.
 *  Facts are monotonic: "missing" (no longer eligible) and "updated" (changed since the snapshot) are never undone
 *  within a snapshot, whatever order results arrive in. "ok" / "paused" follow the newest check of that card only.
 */

/** What a writer captured when it STARTED. */
export type Stamp = {
  snapshotKey: unknown;
  /** Request order across every per-card checker (slice loads and live re-checks share one counter). */
  seq?: number;
  /** Per-run version the request was made for (thread fetches). */
  versions?: ReadonlyMap<string, string>;
};

/** What is current NOW. */
export type Now = {
  snapshotKey: unknown;
  versionOf?: (id: string) => string | undefined;
};

/** True when a result stamped `stamp` may still commit for `id` (or as a whole when `id` is omitted). */
export function isCurrent(stamp: Stamp, now: Now, id?: string): boolean {
  if (stamp.snapshotKey !== now.snapshotKey) return false;
  if (id !== undefined && stamp.versions) {
    const v = stamp.versions.get(id);
    if (v === undefined || !now.versionOf || now.versionOf(id) !== v) return false;
  }
  return true;
}

/**
 * The single commit path: applies `updater` with a FUNCTIONAL update only if the stamp is still current (checked
 * again inside the updater, against the latest state). Returns whether it was current when called.
 */
export function commitIfCurrent<S>(
  stamp: Stamp,
  now: () => Now,
  set: (fn: (prev: S) => S) => void,
  updater: (prev: S) => S,
): boolean {
  if (!isCurrent(stamp, now())) return false;
  set((prev) => (isCurrent(stamp, now()) ? updater(prev) : prev));
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Per-card records

/** "checking" = revealed and waiting for its own first check (actions off, no failure note). */
export type CardStatus = "paused" | "checking" | "ok" | "updated" | "missing";

/** What the snapshot pinned for a card, plus the outcome of its checks. */
export type CardRecord = {
  status: CardStatus;
  /** Sequence of the check that last set ok/paused (load = 0). */
  lastCheckSeq: number;
  snapshotKey: unknown;
  pinnedDraft: string | null;
  pinnedDraftSendable: boolean;
  pinnedReason: string | null;
  pinnedFa: string | null;
  pinnedRun: string | null;
  pinnedAt: string | null;
  /** The pending-row version ("seen through") the snapshot was built from. */
  seenVersion: string | null;
};

export type CardTable = { snapshotKey: unknown; cards: ReadonlyMap<string, CardRecord> };

export type Pinned = Pick<
  CardRecord,
  "pinnedDraft" | "pinnedDraftSendable" | "pinnedReason" | "pinnedFa" | "pinnedRun" | "pinnedAt" | "seenVersion"
>;

/** A card as it loaded: ok when its load ran the fresh version check, paused when that check failed. */
export function loadedCard(snapshotKey: unknown, pinned: Pinned, versionCheckOk: boolean): CardRecord {
  return { ...pinned, snapshotKey, status: versionCheckOk ? "ok" : "paused", lastCheckSeq: 0 };
}

/** One card's result from a check: ok / failed (pause) / updated (changed since snapshot) / gone (no longer eligible). */
export type CheckResult = "ok" | "failed" | "updated" | "gone" | "checking";

/**
 * Applies results stamped `stamp` to the table. Stale snapshot → no change. "gone" and "updated" are facts and
 * always apply (monotonic; "missing" wins over everything). "ok" / "failed" apply only when newer than that card's
 * last check, and never revive a card that is updated or missing. A card the table does not know yet takes the
 * result as its first record only when `pinnedFor` supplies its pins.
 */
export function applyResults(
  table: CardTable,
  stamp: Stamp,
  results: ReadonlyArray<readonly [string, CheckResult]>,
  pinnedFor?: (id: string) => Pinned | undefined,
): CardTable {
  if (stamp.snapshotKey !== table.snapshotKey) return table;
  const seq = stamp.seq ?? 0;
  const cards = new Map(table.cards);
  for (const [id, result] of results) {
    let rec = cards.get(id);
    if (!rec) {
      const pins = pinnedFor?.(id);
      if (!pins) continue;
      rec = { ...pins, snapshotKey: table.snapshotKey, status: "paused", lastCheckSeq: -1 };
    }
    if (rec.status === "missing") continue;
    if (result === "gone") {
      // Terminal within the snapshot: no later or earlier check can change it.
      cards.set(id, { ...rec, status: "missing", lastCheckSeq: Number.MAX_SAFE_INTEGER });
      continue;
    }
    if (result === "updated") {
      cards.set(id, { ...rec, status: "updated", lastCheckSeq: Math.max(rec.lastCheckSeq, seq) });
      continue;
    }
    if (seq <= rec.lastCheckSeq) continue; // an older check than the one that last decided this card
    if (rec.status === "updated") {
      cards.set(id, { ...rec, lastCheckSeq: seq });
      continue;
    }
    cards.set(id, { ...rec, status: result === "ok" ? "ok" : result === "checking" ? "checking" : "paused", lastCheckSeq: seq });
  }
  return { snapshotKey: table.snapshotKey, cards };
}

/** The live values a rendered card currently shows (after enrichment). */
export type LiveView = {
  draftId: string | null;
  draftSendable: boolean;
  flagReason: string | null;
  seenFlagReason: string | null | undefined;
  seenFlagAt: string | null | undefined;
  seenThrough: string | null | undefined;
  activityAt: string | null;
  runId: string | null;
  /** The server's final check found the card changed while the page was built. */
  serverChanged?: boolean;
};

/**
 * Whether the live card differs from what the snapshot pinned. Null cases are explicit:
 *  - pinned reason null vs live reason non-null (or the reverse) is a difference;
 *  - pinned flag time null: the reason is still compared; the time is compared as a value (null ≠ a time);
 *  - pinned run null vs a live run is a difference; pinned draft null vs a live draft is a difference.
 */
export function liveDiffers(rec: Pinned, live: LiveView): boolean {
  if (live.serverChanged) return true;
  if (live.draftId !== rec.pinnedDraft) return true;
  if (rec.pinnedDraft !== null && live.draftSendable !== rec.pinnedDraftSendable) return true;
  if (live.flagReason !== rec.pinnedReason) return true;
  if (live.seenFlagReason !== undefined && (live.seenFlagReason ?? null) !== rec.pinnedReason) return true;
  if (live.seenFlagAt !== undefined && (live.seenFlagAt ?? null) !== rec.pinnedFa) return true;
  if (live.seenThrough !== undefined && (live.seenThrough ?? null) !== rec.seenVersion) return true;
  if (live.activityAt !== rec.pinnedAt) return true;
  if (live.runId !== rec.pinnedRun) return true;
  return false;
}

/** THE rule for a card's actions: its own last check succeeded, it is not updated/missing, and live matches pins. */
export function actionsEnabled(rec: CardRecord | undefined, live: LiveView | undefined, extraUpdated = false): boolean {
  if (!rec || !live) return false;
  if (rec.status !== "ok") return false;
  if (extraUpdated) return false;
  return !liveDiffers(rec, live);
}

/** Why a card is not actionable, for its label. */
export function cardFlags(rec: CardRecord | undefined, live: LiveView | undefined, extraUpdated = false) {
  const updated = rec?.status === "updated" || extraUpdated || (!!rec && !!live && liveDiffers(rec, live));
  return { updated, paused: !rec || rec.status === "paused" || rec.status === "checking", missing: rec?.status === "missing" };
}

// ---------------------------------------------------------------------------------------------------------------
// Per-run thread state

export type ThreadText = { lastOutbound: string | null; reply: string | null };
export type ThreadTable = {
  snapshotKey: unknown;
  text: ReadonlyMap<string, ThreadText>;
  failed: ReadonlySet<string>;
  /** Per run: the request sequence that last decided it (two fetches of one version settle in request order). */
  seqs?: ReadonlyMap<string, number>;
  /** Per run: the version the cached text belongs to (absent = unknown, e.g. server-rendered text). */
  textVersions?: ReadonlyMap<string, string>;
};

/**
 * THE rule for keeping a run's cached reply on screen (used by a failed fetch AND by a refresh): only when the cached
 * text belongs to the run's current version and the run is not failed at that version.
 */
export function keepCachedText(cachedVersion: string | undefined, currentVersion: string | undefined, failedNow: boolean): boolean {
  return !failedNow && cachedVersion !== undefined && currentVersion !== undefined && cachedVersion === currentVersion;
}

/**
 * Refresh: adopt the server's threads and failures. Server text wins for the runs it rendered; a cached text is kept
 * only when keepCachedText allows it for that run's refreshed version (a run the refreshed page does not list keeps
 * its text unless the server reports it failed).
 */
export function adoptServerThreads(
  prev: ThreadTable,
  nextKey: unknown,
  serverText: ReadonlyArray<readonly [string, ThreadText]>,
  serverFailed: readonly string[],
  versionOf: (id: string) => string | undefined,
): ThreadTable {
  const failed = new Set(serverFailed);
  const text = new Map<string, ThreadText>();
  const textVersions = new Map<string, string>();
  for (const [id, t] of prev.text) {
    const cachedV = prev.textVersions?.get(id);
    const nowV = versionOf(id);
    const keep = nowV === undefined ? !failed.has(id) && cachedV !== undefined : keepCachedText(cachedV, nowV, failed.has(id));
    if (keep) {
      text.set(id, t);
      if (cachedV !== undefined) textVersions.set(id, cachedV);
    }
  }
  for (const [id, t] of serverText) {
    if (failed.has(id)) continue;
    text.set(id, t);
    const v = versionOf(id);
    if (v !== undefined) textVersions.set(id, v);
  }
  return { snapshotKey: nextKey, text, failed, seqs: prev.seqs, textVersions };
}

/**
 * Applies a thread fetch result stamped with (snapshot, per-run version, seq). Only runs still at the requested
 * version in the same snapshot, and not already decided by a newer request, change; a run leaves `failed` only when
 * its own text loads at its current version.
 */
export function applyThreads(
  table: ThreadTable,
  stamp: Stamp,
  now: Now,
  loaded: ReadonlyArray<readonly [string, ThreadText]>,
  loadedOk: readonly string[],
  failedIds: readonly string[],
): ThreadTable {
  if (stamp.snapshotKey !== table.snapshotKey || !isCurrent(stamp, now)) return table;
  const seq = stamp.seq ?? 0;
  const text = new Map(table.text);
  const failed = new Set(table.failed);
  const seqs = new Map(table.seqs ?? []);
  const textVersions = new Map(table.textVersions ?? []);
  const fresh = (id: string) => isCurrent(stamp, now, id) && seq >= (seqs.get(id) ?? -1);
  const okSet = new Set(loadedOk);
  const failSet = new Set(failedIds);
  const decided = new Set([...okSet, ...failSet]);
  const take = new Set([...decided].filter(fresh));
  for (const [id, t] of loaded)
    if (take.has(id) && !failSet.has(id)) {
      text.set(id, t);
      const v = stamp.versions?.get(id);
      if (v !== undefined) textVersions.set(id, v);
    }
  for (const id of take) {
    if (failSet.has(id)) {
      failed.add(id);
      // A failed fetch for a DIFFERENT version than the cached text: the cached text is no longer this run's text,
      // so it is removed (the tape shows the retry state, never the old reply as current). Same version: kept.
      if (!keepCachedText(textVersions.get(id), stamp.versions?.get(id), false)) {
        text.delete(id);
        textVersions.delete(id);
      }
    } else failed.delete(id);
    seqs.set(id, seq);
  }
  return { snapshotKey: table.snapshotKey, text, failed, seqs, textVersions };
}
