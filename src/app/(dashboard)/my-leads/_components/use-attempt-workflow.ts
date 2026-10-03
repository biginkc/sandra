"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import type { QueueRow } from "@/lib/my-leads/queries"
import type { Json } from "@/lib/supabase/types"
import { submitMyLeadCommand, submitMyLeadHandoffDrip } from "../actions"
import {
  beginSend, claimClear, claimSubmission, clearWithLease, discardOtherViewers, endSend, getEpoch, hasUncertainSubmission, listSubmissions, listSubmissionsAcrossEpisodes,
  subscribeSubmissions, writeSubmission,
  type Lease, type StoredSubmission, type SubmissionScope,
} from "./submission-store"
import type { MyLeadAction } from "./types"
import type { WorkflowReconciliation } from "./workflow-form"

/**
 * One opening of a workflow dialog. The object's identity is the opening's
 * identity: a new object is a new opening with a fresh idempotency key, and
 * completions that belong to an older object are ignored.
 */
export type AttemptOpening = { action: MyLeadAction; row: QueueRow; callActivityId?: string | null }

type CommandResult = Awaited<ReturnType<typeof submitMyLeadCommand>>

export type AttemptCommitted<O extends AttemptOpening> = {
  opening: O
  input: Record<string, Json>
  result: Extract<CommandResult, { ok: true }>
  dripFailure: string | null
}

type Recovery<O> = {
  opening: O
  message: string
  blocked: boolean
  busy: boolean
  reconciliation?: WorkflowReconciliation
  /** A frozen replay was definitely rejected: the user may release the payload and edit it. */
  canStartOver?: boolean
  /**
   * "May have saved": a record exists whose original request may have committed and the page
   * cannot tell. Plain Save is disabled; Refresh checks and closes; Save as a new update (only
   * while the assignment episode is unchanged) asks to confirm, then saves once under a new key.
   */
  maySaved?: { canSaveNew: boolean }
}

export type AttemptRecoveryValue = {
  message: string
  blocked: boolean
  busy: boolean
  refresh: () => void
  reconciliation?: WorkflowReconciliation
  startOver?: () => void
  saveAsNew?: () => void
  /** A user-initiated close asks first while a save is uncertain or already saved. */
  confirmClose: () => boolean
}

type Submission = {
  opening: AttemptOpening
  key: string
  // Once the request may have crossed the RPC boundary, keep the exact payload
  // that was sent with the key. A retry must replay this pair even if the form
  // was edited while the response was unavailable.
  payload: Record<string, Json> | null
  uncertain: boolean
  /** The server proved a receipt exists for this key: the save already went through. */
  alreadySaved?: boolean
  /** A late success reached this state while its dialog was not on screen: the record says "committed-not-seen" until the rep Refreshes. */
  committedNotSeen?: boolean
  /**
   * The route (which server operation) and member the key was FIRST sent down. A key must
   * never reach a different operation, so an edit that would change either is refused.
   */
  route: string | null
  memberId: string | null
  /** The save is confirmed committed: late answers from older requests must change nothing. */
  committed?: boolean
  /** A request under this key may have committed (it was sent and not definitely rejected). */
  atRisk: boolean
  /** A frozen replay was definitely rejected; the payload stays locked until Start over. */
  definite?: boolean
  /**
   * The original request's payload is gone: released (Start over), dropped (subject mismatch),
   * lost (reload) or dropped on an IDEMPOTENCY_CONFLICT. Nothing can be replayed any more.
   */
  released?: boolean
  /**
   * PROOF that nothing committed under this key: the server rejected the identical frozen
   * request with STALE_STATE/STALE_ASSIGNMENT. Holds the identity of exactly the request it
   * proved; sending a different request clears it, so it never vouches for a later request. Every command raises those only after its
   * receipt lookup (migration 20261003130000), so a committed original would have returned
   * duplicate instead. Only proof (or an explicit Save as a new update) lets the key change.
   */
  staleProof?: string | null
  /** Who started this submission. Fixed at creation: later viewer changes never relabel it. */
  owner: { userId: string; orgId: string }
  /** This instance's write identity. Claims set it as the record's owner; async writes need the matching lease. */
  tag: string
  /** The store epoch read when this state was created; a sign-out or viewer change makes it stale. */
  epoch: number
  lease: Lease | null
  /** The record revision this state last read or wrote. User-action claims compare-and-set against it. Undefined: no record was read (a new submission). */
  readRev?: number
  /** The queue version the original request carried. A request whose version no longer matches the row can never commit. */
  queueVersion: number | null
  createdAt: number
}

/** The routes one dialog action can reach (an attempt can log or finalize; a handoff can go to a drip). */
function routesFor(action: MyLeadAction): string[] {
  if (action === "log-attempt") return ["log_attempt", "finalize_attempt"]
  if (action === "handoff") return ["handoff", "handoff_to_drip"]
  return [action]
}
const pendingOfferId = (row: QueueRow) => (row.offer && row.offer.outcome === "pending" ? row.offer.id : "")
/** Decline and accept are bound to the offer they were started for. */
const carriesOffer = (route: string) => route === "decline-offer" || route === "contract-signed"
function operationOf(route: string, row: QueueRow): string {
  return carriesOffer(route) ? `${route}:${pendingOfferId(row)}` : route
}

/** Which server operation a command reaches; frozen with the key at the first send. */
export function routeOf(command: string, input: Record<string, Json>): string {
  if (command === "log-attempt") return input.source === "sandra" ? "finalize_attempt" : "log_attempt"
  if (command === "handoff") return typeof input.sequenceId === "string" && input.sequenceId ? "handoff_to_drip" : "handoff"
  return command
}

/**
 * A save that has not answered by now is treated like a lost response: the dialog
 * must never sit on a disabled "Saving…". The exact request stays frozen with its
 * idempotency key, so replaying it is safe whether or not the server committed it.
 */
export const SAVE_TIMEOUT_MS = 25_000
class SaveTimeoutError extends Error {
  constructor() { super("The save did not answer in time") }
}
function withSaveTimeout<T>(call: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SaveTimeoutError()), ms)
    call.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

const ALREADY_SAVED_MESSAGE = "This was already saved. Refresh to see it."
const UNCONFIRMED_MESSAGE = "Sandra could not confirm this save. The original request is preserved for reconciliation."
const ROUTE_CHANGED_MESSAGE = "A save on this lead may already have gone through as a different kind of update. Choose the same kind of update to save again."
export const RESUME_NOTICE = "A save on this lead may already have gone through. Saving again won't create a duplicate."
export const MAY_HAVE_SAVED_MESSAGE = "A save on this lead may already have gone through. Refresh to check, or save this as a new update."
export const MAY_HAVE_SAVED_REFRESH_ONLY_MESSAGE = "A save on this lead may already have gone through, and the lead has changed. Refresh to check."
export const NEW_UPDATE_CONFIRM_MESSAGE = "The earlier save may already have gone through. Saving as a new update could record it twice. Save as a new update anyway?"
export const SAVED_EARLIER_MESSAGE = "Saved earlier. Refresh to see it."
export const UPDATED_MESSAGE = "This lead was updated. Refresh to see it."
export const SUPERSEDED_MESSAGE = "This save was updated somewhere else. Check the lead before trying again."
export const NO_VIEWER_MESSAGE = "Sign in with an active organization before updating a lead."
export const NO_REP_MESSAGE = "This lead has no assigned rep, so it can't be updated here."
export const HELD_SUFFIX = " This save is held. Cancel to leave it; it expires after 24 hours."
export const CANT_SAVE_MESSAGE = "Sandra can't save these values. Start over to edit them."
export const CLOSE_CONFIRM_MESSAGE = "This save may already have gone through. Close anyway? Reopening this lead picks up where you left off."
/** Server validation codes that fail the same way every time for the same values. */
const DETERMINISTIC_VALIDATION_CODES = new Set(["MOTIVATION_REQUIRED", "RECORDING_REQUIRED"])

type Failure = { message: string; code?: string; certainty?: "rejected" | "unknown"; answered?: boolean }

export type UseAttemptWorkflowOptions<O extends AttemptOpening> = {
  /** The currently open dialog, or null. */
  opening: O | null
  /** The rep whose queue holds the lead. Null when the lead has no assignee: nothing is ever recorded then. */
  memberId: string | null
  /** The signed-in viewer. Saved-attempt records are scoped to them and discarded for anyone else. Null when signed out: nothing is ever recorded then. */
  viewer: { userId: string; orgId: string } | null
  /**
   * Reads the lead's current row for recovery. Resolve null when the lead is no
   * longer reachable from the host's source; reject when the read itself failed.
   */
  readRow: (opening: O) => Promise<QueueRow | null>
  /**
   * Called synchronously right after a confirmed save. The host publishes its
   * own refresh barrier here and returns the read that follows the command.
   */
  onCommitted: (committed: AttemptCommitted<O>) => Promise<unknown>
  /** Called once that read settles (host refreshes its server data / surfaces a drip failure). */
  onSettled: (committed: AttemptCommitted<O>) => void
  /**
   * Optional host refresh barrier for an already-saved conflict that cannot be replayed (the
   * frozen request is gone). Re-reads the host's data; carries no result details.
   */
  onReconciled?: (opening: O) => Promise<unknown>
  /** Closes the dialog; only called for actions that end after one save. */
  onClose: (opening: O) => void
  /** Called when the drip step changed the lead's queue state. */
  onDripChanged: () => void
  /** Overrides SAVE_TIMEOUT_MS (tests). */
  saveTimeoutMs?: number
}

/**
 * Submission and recovery core shared by every host of the attempt dialog.
 * Host-specific freshness barriers stay in the host via the callbacks above.
 *
 * The idempotency key and its record outlive the dialog: they live in the submission store,
 * keyed by viewer, rep, lead, assignment episode and the actual route, so Cancel, close,
 * unmount, navigation or a reload while a save is uncertain cannot lose the key.
 */
export function useAttemptWorkflow<O extends AttemptOpening>({
  opening, memberId: memberIdOption, viewer: viewerOption, readRow, onCommitted, onSettled, onReconciled, onClose, onDripChanged, saveTimeoutMs = SAVE_TIMEOUT_MS,
}: UseAttemptWorkflowOptions<O>) {
  // Records need a viewer, an organization and a rep. Without all three nothing is resumed,
  // recorded or sent (the guards below), so the empty placeholders are never used as an identity.
  const identified = Boolean(viewerOption?.userId && viewerOption.orgId && memberIdOption)
  const memberId = memberIdOption ?? ""
  const viewer = viewerOption ?? { userId: "", orgId: "" }
  const submission = useRef<Submission | null>(null)
  const activeOpening = useRef(opening)
  const callbacks = useRef({ onCommitted, onSettled, onReconciled, onClose, onDripChanged })
  const viewerRef = useRef(viewer)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => { activeOpening.current = opening; callbacks.current = { onCommitted, onSettled, onReconciled, onClose, onDripChanged }; viewerRef.current = viewer })
  const orphaned = useRef<{ opening: O; records: StoredSubmission[] } | null>(null)
  const allowNewKey = useRef<O | null>(null)
  /** The opening that ever held or resumed a record. It may never mint a key by itself afterwards. */
  const heldFor = useRef<O | null>(null)
  const mounted = useRef(false)
  const recoveredRow = useRef<{ opening: O; row: QueueRow } | null>(null)
  const [recovery, setRecovery] = useState<Recovery<O> | null>(null)

  const scopeFor = (current: O, member: string, owner: { userId: string; orgId: string } = viewerRef.current): SubmissionScope => ({
    viewerUserId: owner.userId, orgId: owner.orgId, memberId: member,
    propertyId: current.row.propertyId, assignmentEpisodeId: current.row.assignmentEpisodeId,
  })
  const recordOf = (state: Submission, current: O): StoredSubmission | null => {
    if (!state.route) return null
    const status = state.committedNotSeen ? "committed-not-seen" : state.committed ? "committed" : state.alreadySaved ? "already-saved" : state.atRisk ? "uncertain" : "fresh"
    return {
      ...scopeFor(current, state.memberId ?? memberId, state.owner), operation: operationOf(state.route, current.row), key: state.key, route: state.route,
      status, createdAt: state.createdAt, payload: status === "fresh" ? null : state.payload, expectedQueueVersion: state.queueVersion,
    }
  }
  /** CLAIM (a user action). The payload goes to memory only (see submission-store). False: this state lost its authority. */
  const claim = (state: Submission, current: O, options: { send?: boolean; replaceKey?: boolean } = {}): boolean => {
    const record = recordOf(state, current)
    if (!record) return true
    const lease = claimSubmission(record, state.tag, { epoch: state.epoch, expectRev: state.lease?.rev ?? state.readRev, ...options })
    if (!lease) return false
    state.lease = lease
    state.readRev = lease.rev
    heldFor.current = current
    return true
  }
  /** CONDITIONAL WRITE (an async result). False: this state was superseded and must not act. */
  const write = (state: Submission, current: O): boolean => {
    const record = recordOf(state, current)
    if (!record) return true
    if (!state.lease) return false
    const lease = writeSubmission(state.lease, record)
    if (!lease) return false
    state.lease = lease
    state.readRev = lease.rev
    return true
  }
  /** Conditional clear of a record this state owns. */
  const drop = (state: Submission): boolean => (state.lease ? clearWithLease(state.lease) : false)
  /** Claimed clear (a user action): removes the record when it still carries this state's key. */
  const claimDrop = (state: Submission, current: O): boolean => {
    const record = recordOf(state, current)
    return record ? claimClear(record, { epoch: state.epoch, expectKey: state.key, expectRev: state.lease?.rev ?? state.readRev }) : true
  }

  // Identity change: another viewer's or organization's records are discarded, not just hidden.
  useEffect(() => {
    if (identified) discardOtherViewers({ userId: viewer.userId, orgId: viewer.orgId })
    // Pending work and in-memory state belong to the previous owner: the store epoch already refuses
    // their late writes; drop the in-memory state too.
    if (submission.current && (submission.current.owner.userId !== viewer.userId || submission.current.owner.orgId !== viewer.orgId)) {
      submission.current = null
      recoveredRow.current = null
      orphaned.current = null
      setRecovery(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer.userId, viewer.orgId])

  // A warning before the page unloads while a save with its payload is still unresolved.
  const anyUncertain = useSyncExternalStore(subscribeSubmissions, hasUncertainSubmission, () => false)
  useEffect(() => {
    if (!anyUncertain) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [anyUncertain])

  /** Picks up a record left by an earlier opening, remount or page load for this lead and action. */
  const resume = (current: O) => {
    if (!identified || submission.current?.opening === current) return
    // EXACT identity only: route plus, for decline/accept, the pending offer. A record for another
    // offer is never resumed, so that offer gets its own new key.
    const wanted = routesFor(current.action).map((route) => operationOf(route, current.row))
    const records = listSubmissions(scopeFor(current, memberId), (operation) => wanted.includes(operation))
      .sort((a, b) => b.createdAt - a.createdAt)
    // Opening is READ-ONLY: a committed or fresh record has nothing left to protect, so it is simply
    // ignored here (the next send overwrites it with a new key). Nothing is written or claimed.
    const record = records.find((item) => item.status === "uncertain" || item.status === "already-saved" || item.status === "committed-not-seen")
    if (!record) {
      // Re-read table: no record (or one that was seen and cleared) is a fresh form ONLY for an
      // opening that never held or resumed a record. One that did must not mint a key by itself.
      if (heldFor.current === current) {
        setRecovery({ opening: current, message: UPDATED_MESSAGE, blocked: true, busy: false, maySaved: { canSaveNew: false } })
        return
      }
      // The assignment episode changed under an unresolved record: it may have committed in the
      // old episode. Never clear it silently and never offer a new update inside the new episode.
      const orphans = listSubmissionsAcrossEpisodes(
        { viewerUserId: viewerRef.current.userId, orgId: viewerRef.current.orgId, memberId, propertyId: current.row.propertyId },
        (operation) => wanted.some((w) => w === operation),
      ).filter((item) => item.assignmentEpisodeId !== current.row.assignmentEpisodeId && (item.status === "uncertain" || item.status === "already-saved"))
      if (orphans.length > 0) {
        orphaned.current = { opening: current, records: orphans }
        setRecovery({ opening: current, message: MAY_HAVE_SAVED_REFRESH_ONLY_MESSAGE, blocked: true, busy: false, maySaved: { canSaveNew: false } })
      }
      return
    }
    const subjectMatches = !record.payload || routeOf(current.action, record.payload) === record.route
    // The row moved on (another route): keep the key, drop the values.
    const payload = subjectMatches ? record.payload : null
    const state: Submission = {
      opening: current, key: record.key, payload, uncertain: record.status === "uncertain" && payload !== null,
      alreadySaved: record.status === "already-saved", committedNotSeen: record.status === "committed-not-seen", route: record.route, memberId, atRisk: true,
      createdAt: record.createdAt, released: payload === null, owner: { ...viewerRef.current }, queueVersion: record.expectedQueueVersion ?? null,
      tag: crypto.randomUUID(), epoch: getEpoch(), lease: null, readRev: record.rev ?? 0,
    }
    submission.current = state
    heldFor.current = current
    // The only write on open: dropping a payload that no longer fits this row (a claim; a failure is harmless).
    if (payload !== record.payload) claim(state, current)
    // A reload lost the payload and the row has moved since the request was sent: the original may
    // have committed (which is what moved it). That is NOT proof of anything: ask.
    const moved = record.status === "uncertain" && !record.payload && typeof record.expectedQueueVersion === "number" && record.expectedQueueVersion !== current.row.queueVersion
    if (state.committedNotSeen) setRecovery({ opening: current, message: SAVED_EARLIER_MESSAGE, blocked: true, busy: false })
    else if (state.alreadySaved) setRecovery({ opening: current, message: ALREADY_SAVED_MESSAGE, blocked: true, busy: false })
    else if (moved) setRecovery({ opening: current, message: MAY_HAVE_SAVED_MESSAGE, blocked: true, busy: false, maySaved: { canSaveNew: true } })
    else if (state.uncertain) setRecovery({ opening: current, message: UNCONFIRMED_MESSAGE, blocked: false, busy: false, reconciliation: { command: current.action, payload: payload! } })
    else if (state.atRisk) setRecovery({ opening: current, message: RESUME_NOTICE, blocked: false, busy: false })
  }
  useEffect(() => {
    // Resuming reads an external store (module map + sessionStorage) and publishes the result once per opening.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (opening) resume(opening)
    return () => {
      // Closing keeps an unresolved record. A confirmed save whose dialog is now gone is finished.
      const state = submission.current
      if (opening && state?.opening === opening && state.committed && !state.committedNotSeen) drop(state)
    }
    // resume/forget only read refs and module state; the opening is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening])

  /**
   * This state lost its authority (another instance claimed the record, or a sign-out / viewer change
   * bumped the epoch). It drops its in-memory state, runs NO host callback, leaves the dialog to the
   * store (re-read through resume) and answers with a neutral non-ok result.
   */
  const superseded = (state: Submission, current: O) => {
    if (submission.current === state) submission.current = null
    if (recoveredRow.current?.opening === current) recoveredRow.current = null
    if (activeOpening.current === current) {
      setRecovery(null)
      resume(current)
    }
    return { ok: false as const, certainty: "unknown" as const, message: SUPERSEDED_MESSAGE }
  }

  // While a request may have committed, its exact payload stays locked in the form, through
  // Refresh too: Refresh only re-reads the row and never releases the frozen payload.
  const frozenFor = (current: O): WorkflowReconciliation | undefined => {
    const state = submission.current
    return state?.opening === current && state.uncertain && state.payload ? { command: current.action, payload: state.payload } : undefined
  }

  /** Sends one frozen or fresh request down its real route. Shared by Save and the already-saved replay. */
  const dispatch = (command: string, input: Record<string, Json>, row: QueueRow, sendMember: string, key: string): Promise<CommandResult> =>
    Promise.resolve(command === "handoff" && typeof input.sequenceId === "string" && input.sequenceId
      ? submitMyLeadHandoffDrip({ memberId: sendMember, propertyId: row.propertyId, sequenceId: input.sequenceId,
          reason: "not_interested", expectedEpisodeId: typeof input.expectedEpisodeId === "string" ? input.expectedEpisodeId : row.assignmentEpisodeId,
          expectedQueueVersion: typeof input.expectedQueueVersion === "number" ? input.expectedQueueVersion : row.queueVersion,
          expectedSharedStatus: typeof input.expectedSharedStatus === "string" ? input.expectedSharedStatus : row.sharedStatus,
          idempotencyKey: key })
      : submitMyLeadCommand(command as Parameters<typeof submitMyLeadCommand>[0], input))

  /** The committed path. False: the state was superseded, so nothing ran (no write, no host callback). */
  const finishCommitted = async (current: O, state: Submission, input: Record<string, Json>, result: Extract<CommandResult, { ok: true }>): Promise<boolean> => {
    state.committed = true
    state.definite = false
    // A late success that reaches a dialog nobody is looking at (unmounted, closed or another
    // opening) is NOT seen: record it as committed-not-seen. Only the rep's Refresh clears it, so
    // nothing can mint a new key for the same save in the meantime.
    if (!mounted.current || activeOpening.current !== current) {
      state.committedNotSeen = true
      if (!write(state, current)) { state.committed = false; state.committedNotSeen = false; return false }
      return true
    }
    // A save a newer owner has taken over is theirs to resolve: the record stays uncertain and their
    // replay returns duplicate through this same path.
    const keepsOpen = current.action === "log-attempt" || current.action === "handoff"
    if (keepsOpen ? !write(state, current) : !drop(state)) { state.committed = false; return false }
    const dripFailure = "dripFailure" in result && result.dripFailure ? `Outcome saved. Drip not started: ${result.dripFailure}` : null
    setRecovery(null)
    const committed: AttemptCommitted<O> = { opening: current, input, result, dripFailure }
    // The host publishes its refresh barrier before the dialog can close so a
    // rapid next click is initialized from authorized post-command metadata.
    const read = callbacks.current.onCommitted(committed)
    // A saved attempt (or handoff) keeps its dialog open for the optional
    // drip step, whatever the outcome. Other actions end with the save.
    if (!keepsOpen) {
      callbacks.current.onClose(current)
      if (submission.current === state) submission.current = null
      await read
      callbacks.current.onSettled(committed)
    } else {
      // Kept until the dialog closes (see the opening effect's cleanup).
      void read.then(() => callbacks.current.onSettled(committed))
    }
    return true
  }

  /**
   * The user's "Refresh to check" for an already-saved or may-have-saved record: re-read the lead
   * (a failed read stays retryable), run the host refresh barrier, clear the record and close.
   * Nothing is claimed about the earlier save; the refreshed queue is what the rep sees.
   */
  const refreshAndClose = async (current: O) => {
    await readRow(current)
    if (activeOpening.current !== current) return
    const held = submission.current
    if (held?.opening === current && !claimDrop(held, current)) { superseded(held, current); return }
    const barrier = callbacks.current.onReconciled?.(current)
    if (orphaned.current?.opening === current)
      for (const record of orphaned.current.records) claimClear(record, { epoch: getEpoch(), expectKey: record.key })
    orphaned.current = null
    submission.current = null
    setRecovery(null)
    callbacks.current.onClose(current)
    await barrier
  }

  const recover = async () => {
    const current = opening
    if (!current || recovery?.busy) return
    setRecovery({ opening: current, message: "Checking current lead access…", blocked: true, busy: true, reconciliation: frozenFor(current), maySaved: recovery?.opening === current ? recovery.maySaved : undefined })
    try {
      const earlier = submission.current
      if (earlier?.opening === current && (earlier.alreadySaved || earlier.committedNotSeen)) {
        // acquisition_commands cannot be read by any client role, and the server raises
        // IDEMPOTENCY_CONFLICT only when the stored request DIFFERS from the incoming one, so
        // replaying never helps. No result is claimed (see refreshAndClose).
        await refreshAndClose(current)
        return
      }
      if (recovery?.opening === current && recovery.maySaved) {
        await refreshAndClose(current)
        return
      }
      const row = await readRow(current)
      if (activeOpening.current !== current) return
      // Never move a retained draft into a different assignment episode.
      const gone = !row || row.assignmentEpisodeId !== current.row.assignmentEpisodeId
      if (gone && submission.current?.opening === current && submission.current.released) {
        // No frozen payload to protect and the lead left the queue or changed episode: the old
        // request may have committed. Never clear silently; Refresh-to-check only.
        setRecovery({ opening: current, message: MAY_HAVE_SAVED_REFRESH_ONLY_MESSAGE, blocked: true, busy: false, maySaved: { canSaveNew: false } })
        return
      }
      if (!row || row.assignmentEpisodeId !== current.row.assignmentEpisodeId) {
        setRecovery({ opening: current, message: "This lead is unavailable in this queue or its assignment changed. Your draft is retained; copy it before closing. Reopen the lead from the current queue to start a new update.", blocked: true, busy: false, reconciliation: frozenFor(current) })
        return
      }
      // Refreshing an opening after a stale response does not start a new
      // submission. Keep its idempotency key so retrying the same command is
      // safe even when the draft was edited while the dialog was blocked.
      recoveredRow.current = { opening: current, row }
      const definite = submission.current?.opening === current && submission.current.definite
      setRecovery({ opening: current, message: definite ? CANT_SAVE_MESSAGE : "Lead refreshed. Your draft is retained. Review it before saving.", blocked: false, busy: false, reconciliation: frozenFor(current), canStartOver: definite || undefined })
    } catch {
      if (activeOpening.current === current) setRecovery({ opening: current, message: "Could not refresh this lead. Your draft is retained. Try Refresh again.", blocked: true, busy: false, reconciliation: frozenFor(current), maySaved: recovery?.opening === current ? recovery.maySaved : undefined, canStartOver: (submission.current?.opening === current && submission.current.definite) || undefined })
    }
  }

  /** Releases a definitely rejected frozen payload for editing. The key and route are kept. */
  const startOver = () => {
    const current = opening
    const state = submission.current
    if (!current || state?.opening !== current || !state.definite) return
    state.uncertain = false
    state.definite = false
    state.payload = null
    state.released = true
    if (!claim(state, current)) { superseded(state, current); return }
    setRecovery({ opening: current, message: RESUME_NOTICE, blocked: false, busy: false })
  }

  /**
   * Explicit user choice: this is a new update. Confirming only ARMS it for this opening; the old
   * record is forgotten and the new key minted inside submit, at send time. Closing the dialog
   * before sending keeps the record and the may-have-saved state.
   */
  const saveAsNew = () => {
    const current = opening
    if (!current || recovery?.opening !== current || !recovery.maySaved?.canSaveNew || typeof window === "undefined") return
    if (!window.confirm(NEW_UPDATE_CONFIRM_MESSAGE)) return
    allowNewKey.current = current
    setRecovery(null)
  }

  const confirmClose = useCallback(() => {
    const state = submission.current
    const risky = Boolean(opening && ((state?.opening === opening && !state.committed && (state.uncertain || state.alreadySaved)) || (recovery?.opening === opening && recovery.maySaved)))
    if (!risky || typeof window === "undefined") return true
    return window.confirm(CLOSE_CONFIRM_MESSAGE)
  }, [opening, recovery])

  const submit = useCallback(async (payload: object) => {
    if (!opening) return { ok: false as const, message: "Select a lead first." }
    if (!identified) return { ok: false as const, message: !viewerOption?.userId || !viewerOption.orgId ? NO_VIEWER_MESSAGE : NO_REP_MESSAGE }
    if (recovery?.opening === opening && (recovery.blocked || recovery.busy)) return { ok: false as const, message: recovery.message }
    // An armed "Save as a new update": retire the old record and key now, at send time.
    if (allowNewKey.current === opening) {
      allowNewKey.current = null
      const held = submission.current
      if (held?.opening === opening && !claimDrop(held, opening)) return superseded(held, opening)
      heldFor.current = null // an explicit, confirmed new update
      submission.current = null
      recoveredRow.current = null
    }
    // An opening that ever held or resumed a record never mints a key by itself: re-read instead.
    if (submission.current?.opening !== opening && heldFor.current === opening) {
      resume(opening)
      return { ok: false as const, certainty: "unknown" as const, message: SUPERSEDED_MESSAGE }
    }
    const row = recoveredRow.current?.opening === opening ? recoveredRow.current.row : opening.row
    // A command's idempotency key belongs to the opening, not to the current
    // draft contents. Before the RPC is known to have crossed its boundary, a
    // definite rejection may be retried with refreshed queue metadata. Once transport
    // or confirmation is uncertain, the original payload and key become one
    // immutable replay pair, so an edited draft cannot produce an idempotency conflict.
    if (submission.current?.opening !== opening) submission.current = { opening, key: crypto.randomUUID(), payload: null, uncertain: false, route: null, memberId: null, atRisk: false, queueVersion: null, createdAt: Date.now(), owner: { ...viewerRef.current }, tag: crypto.randomUUID(), epoch: getEpoch(), lease: null }
    const state = submission.current
    const command = opening.action as Parameters<typeof submitMyLeadCommand>[0]
    const frozen = state.uncertain && state.payload
    const wantedRoute = routeOf(command, JSON.parse(JSON.stringify(payload)) as Record<string, Json>)
    // Never send the key down another operation. When nothing under the key can have committed
    // (its first send was definitely rejected), a different route simply starts a new key.
    if (state.route !== null && (state.route !== wantedRoute || state.memberId !== memberId) && !frozen) {
      // Only PROOF lifts the lock: the identical frozen request was rejected with STALE_*.
      if (state.atRisk && !state.staleProof) {
        // Refused, but never a dead end: the rep may explicitly save this as a new update.
        setRecovery({ opening, message: ROUTE_CHANGED_MESSAGE, blocked: false, busy: false, maySaved: { canSaveNew: true } })
        return { ok: false as const, certainty: "rejected" as const, message: ROUTE_CHANGED_MESSAGE }
      }
      if (!claimDrop(state, opening)) return superseded(state, opening)
      state.key = crypto.randomUUID()
      state.lease = null
      state.readRev = undefined
      state.route = null
      state.memberId = null
      state.released = false
      state.staleProof = null
      state.queueVersion = null
      state.createdAt = Date.now()
    }
    const nextInput = JSON.parse(JSON.stringify({ ...payload, propertyId: row.propertyId, expectedEpisodeId: row.assignmentEpisodeId,
      expectedQueueVersion: row.queueVersion, expectedSharedStatus: row.sharedStatus, idempotencyKey: state.key })) as Record<string, Json>
    const input = frozen ? state.payload! : nextInput
    // Freeze the route and member with the key at the first send.
    const route = routeOf(command, input)
    state.route ??= route
    state.memberId ??= memberId
    const sendMember = state.memberId
    // Keep the reconciliation receipt mounted while the exact original request is replayed.
    if (!(recovery?.opening === opening && recovery.reconciliation)) setRecovery(null)
    // A proof vouches only for the request it proved: any different request clears it.
    if (state.staleProof !== JSON.stringify(input)) state.staleProof = null
    state.payload = input
    state.queueVersion = typeof input.expectedQueueVersion === "number" ? input.expectedQueueVersion : null
    // From here the request may reach Postgres: record the key (and the payload, in memory only)
    // BEFORE sending, so a close, unmount or reload mid-flight cannot lose it.
    const wasAtRisk = state.atRisk
    state.atRisk = true
    state.definite = false
    // CLAIM: this send takes write authority over the record (and fails if a newer owner, a sign-out or
    // a viewer change got there first, or another instance holds an unresolved record with another key).
    if (!claim(state, opening, { send: true })) return superseded(state, opening)
    beginSend()
    try {
      const markUncertain = (message?: string): boolean => {
        state.uncertain = true
        state.atRisk = true
        if (!write(state, opening)) return false
        if (activeOpening.current === opening) setRecovery({ opening, message: message ?? UNCONFIRMED_MESSAGE, blocked: false, busy: false, reconciliation: { command, payload: state.payload ?? input } })
        return true
      }
      /** True when the failure was applied; false when this state was superseded and must stand down. */
      const applyFailure = (failure: Failure): boolean => {
        // A save that is already confirmed committed is not changed by a late, older answer.
        if (state.committed) return true
        // A frozen replay the server ANSWERED with a database error is Start-over-able whatever the cause:
        // the key never changes, so if the original committed a different payload under it can only
        // conflict, and pre-lookup errors never commit. Access errors keep their own replayable path.
        const definite = failure.certainty === "rejected" || Boolean(failure.answered && failure.code && DETERMINISTIC_VALIDATION_CODES.has(failure.code)) ||
          Boolean(failure.answered && state.uncertain && failure.code !== "IDEMPOTENCY_CONFLICT" && failure.code !== "FORBIDDEN" && failure.code !== "UNAUTHENTICATED")
        // A frozen replay refused for access reasons holds the save: say so honestly.
        const accessMessage = (message: string) => (frozen && (failure.code === "FORBIDDEN" || failure.code === "UNAUTHENTICATED") ? `${message}${HELD_SUFFIX}` : message)
        if (failure.code === "IDEMPOTENCY_CONFLICT") {
          // A receipt exists for this key, so the save already went through. Never loop,
          // never rotate the key: block with plain copy until a verified lookup succeeds.
          state.alreadySaved = true
          state.uncertain = false
          state.released = true
          state.payload = null
          if (!write(state, opening)) return false
          if (activeOpening.current === opening) setRecovery({ opening, message: failure.message, blocked: true, busy: false })
        } else if (definite || (failure.answered && !state.uncertain)) {
          // (An answered failure on a first send, with nothing frozen, could not have committed: no
          // earlier send under this key exists. It is shown as the server's field error, not frozen.)
          if (state.uncertain) {
            // A frozen replay the server definitely rejected: nothing committed under this key. The
            // values stay locked and visible until the user chooses Start over, which releases the
            // payload and KEEPS the key and route: a late original commit then conflicts instead of
            // recording a second attempt.
            state.definite = true
            if (failure.answered && (failure.code === "STALE_STATE" || failure.code === "STALE_ASSIGNMENT")) state.staleProof = JSON.stringify(input)
            if (!write(state, opening)) return false
            if (activeOpening.current === opening) setRecovery({ opening, message: CANT_SAVE_MESSAGE, blocked: false, busy: false, reconciliation: { command, payload: state.payload ?? input }, canStartOver: true })
            return true
          }
          // Nothing earlier existed under this key (or it is still at risk from before this send).
          state.atRisk = wasAtRisk
          // A resumed save (key kept, no payload) answered with a rejection: do not freeze the REFUSED payload.
          if (wasAtRisk && !state.uncertain) { state.payload = null; state.released = true }
          // Returning to "fresh" is allowed only for the ONLY send under this key (the store enforces it).
          if (!write(state, opening)) return false
          if ((failure.code === "FORBIDDEN" || failure.code === "STALE_STATE") && activeOpening.current === opening)
            setRecovery({ opening, message: failure.message, blocked: true, busy: false })
          else setRecovery((current) => (current?.opening === opening && current.reconciliation ? null : current))
        } else {
          // Unknown outcome (transport/auth errors, missing confirmation, unexpected
          // exceptions): the request may have committed, so keep it frozen for replay.
          // Actionable guidance from the server (an expired session) is shown as is.
          if (!markUncertain(failure.code === "UNAUTHENTICATED" ? accessMessage(failure.message) : undefined)) return false
          if ((failure.code === "FORBIDDEN" || failure.code === "STALE_STATE") && activeOpening.current === opening)
            setRecovery({ opening, message: accessMessage(failure.message), blocked: true, busy: false, reconciliation: { command, payload: state.payload ?? input } })
        }
        return true
      }
      const send = (): Promise<CommandResult> => dispatch(command, input, row, sendMember ?? memberId, state.key)
      const call = send()
      let result: CommandResult
      try {
        result = await withSaveTimeout(call, saveTimeoutMs)
      } catch (error) {
        // A rejected server action can mean the request reached Postgres but its
        // response did not reach the browser. Retain the exact request so the
        // next click is a server-side replay instead of a second mutation. The mark is a
        // conditional write: a superseded state stands down instead.
        if (!state.committed && !markUncertain()) return superseded(state, opening)
        // A late answer from this timed-out request is deliberately ignored: a Reconcile replay
        // of the frozen request returns the stored result (duplicate) through the normal path.
        throw error
      }
      if (!result.ok) { if (!applyFailure(result as Failure)) return superseded(state, opening) }
      else if (!(await finishCommitted(opening, state, input, result))) return superseded(state, opening)
      return result
    } finally {
      endSend()
    }
    // finishCommitted only reads refs and state setters, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, recovery, memberId, identified, saveTimeoutMs])

  const recoveryValue: AttemptRecoveryValue | null = recovery?.opening === opening
    ? { message: recovery.message, blocked: recovery.blocked, busy: recovery.busy, reconciliation: recovery.reconciliation, refresh: () => void recover(), confirmClose,
        ...(recovery.canStartOver ? { startOver } : {}), ...(recovery.maySaved?.canSaveNew ? { saveAsNew } : {}) }
    : null

  return { submit, recoveryValue, onDripChanged, confirmClose }
}
