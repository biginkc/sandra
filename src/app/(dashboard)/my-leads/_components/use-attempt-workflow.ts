"use client"

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react"

import type { QueueRow } from "@/lib/my-leads/queries"
import type { Json } from "@/lib/supabase/types"
import { loadMyLeadCommandReceipt, submitMyLeadCommand, submitMyLeadHandoffDrip, type MyLeadReceiptFollowUp } from "../actions"
import {
  clearSubmission, discardOtherViewers, hasUncertainSubmission, listSubmissions, saveSubmission, subscribeSubmissions,
  type StoredSubmission, type SubmissionScope,
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
}

export type AttemptRecoveryValue = {
  message: string
  blocked: boolean
  busy: boolean
  refresh: () => void
  reconciliation?: WorkflowReconciliation
  startOver?: () => void
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
  /** The earlier save is confirmed; the next Save only continues to the follow-up/drip step. */
  savedEarlier?: boolean
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
  /** Follow-up status read from a verified receipt, shown display-only. */
  savedFollowUp?: MyLeadReceiptFollowUp & { message: string | null } | null
  createdAt: number
}

/** The server-side operation name for each route, as stored in acquisition_commands. */
const DB_OPERATION: Record<string, string> = {
  log_attempt: "log_acquisition_attempt",
  finalize_attempt: "finalize_acquisition_attempt",
  handoff: "handoff_acquisition_lead",
  handoff_to_drip: "handoff_acquisition_lead_to_drip",
  "ready-for-offer": "ready_acquisition_offer",
  "log-offer": "log_acquisition_offer",
  "contract-signed": "record_acquisition_contract",
  "decline-offer": "decline_acquisition_offer",
  archive: "archive_acquisition_contract",
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
const SAVED_EARLIER_MESSAGE = "Saved earlier. Your update is recorded."
export const RESUME_NOTICE = "A save on this lead may already have gone through. Saving again won't create a duplicate."
export const CANT_SAVE_MESSAGE = "Sandra can't save these values. Start over to edit them."
export const CLOSE_CONFIRM_MESSAGE = "This save may already have gone through. Close anyway? Reopening this lead picks up where you left off."
/** Server validation codes that fail the same way every time for the same values. */
const DETERMINISTIC_VALIDATION_CODES = new Set(["MOTIVATION_REQUIRED", "RECORDING_REQUIRED"])

type Failure = { message: string; code?: string; certainty?: "rejected" | "unknown"; answered?: boolean }

export type UseAttemptWorkflowOptions<O extends AttemptOpening> = {
  /** The currently open dialog, or null. */
  opening: O | null
  memberId: string
  /** The signed-in viewer. Saved-attempt records are scoped to them and discarded for anyone else. */
  viewer: { userId: string; orgId: string }
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
  opening, memberId, viewer, readRow, onCommitted, onSettled, onClose, onDripChanged, saveTimeoutMs = SAVE_TIMEOUT_MS,
}: UseAttemptWorkflowOptions<O>) {
  const submission = useRef<Submission | null>(null)
  const activeOpening = useRef(opening)
  const callbacks = useRef({ onCommitted, onSettled, onClose, onDripChanged })
  const viewerRef = useRef(viewer)
  useEffect(() => { activeOpening.current = opening; callbacks.current = { onCommitted, onSettled, onClose, onDripChanged }; viewerRef.current = viewer })
  const recoveredRow = useRef<{ opening: O; row: QueueRow } | null>(null)
  const [recovery, setRecovery] = useState<Recovery<O> | null>(null)

  const scopeFor = (current: O, member: string): SubmissionScope => ({
    viewerUserId: viewerRef.current.userId, orgId: viewerRef.current.orgId, memberId: member,
    propertyId: current.row.propertyId, assignmentEpisodeId: current.row.assignmentEpisodeId,
  })
  const recordOf = (state: Submission, current: O): StoredSubmission | null => {
    if (!state.route) return null
    const status = state.committed ? "committed" : state.alreadySaved ? "already-saved" : state.atRisk ? "uncertain" : "fresh"
    return {
      ...scopeFor(current, state.memberId ?? memberId), operation: operationOf(state.route, current.row), key: state.key, route: state.route,
      status, createdAt: state.createdAt, payload: status === "fresh" ? null : state.payload,
    }
  }
  /** Mirrors the submission into the store. The payload goes to memory only (see submission-store). */
  const persist = (state: Submission, current: O) => {
    const record = recordOf(state, current)
    if (record) saveSubmission(record)
  }
  const forget = (state: Submission, current: O) => {
    const record = recordOf(state, current)
    if (record) clearSubmission(record)
  }

  // Identity change: another viewer's or organization's records are discarded, not just hidden.
  useEffect(() => { discardOtherViewers({ userId: viewer.userId, orgId: viewer.orgId }) }, [viewer.userId, viewer.orgId])

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
    if (submission.current?.opening === current) return
    const routes = routesFor(current.action)
    const records = listSubmissions(scopeFor(current, memberId), (operation) => routes.some((route) => operation === route || operation.startsWith(`${route}:`)))
      .sort((a, b) => b.createdAt - a.createdAt)
    // A committed record has nothing left to protect, and a fresh one never had a request that
    // could have committed: a new opening is a new save with a new key.
    for (const record of records) if (record.status === "committed" || record.status === "fresh") clearSubmission(record)
    const record = records.find((item) => item.status === "uncertain" || item.status === "already-saved")
    if (!record) return
    const offerSuffix = record.operation.includes(":") ? record.operation.slice(record.operation.indexOf(":") + 1) : ""
    const subjectMatches = offerSuffix === (carriesOffer(record.route) ? pendingOfferId(current.row) : "") &&
      (!record.payload || routeOf(current.action, record.payload) === record.route)
    // The row moved on (another offer, another route): keep the key, drop the values.
    const payload = subjectMatches ? record.payload : null
    const state: Submission = {
      opening: current, key: record.key, payload, uncertain: record.status === "uncertain" && payload !== null,
      alreadySaved: record.status === "already-saved", route: record.route, memberId, atRisk: true,
      createdAt: record.createdAt,
    }
    submission.current = state
    if (payload !== record.payload) persist(state, current)
    if (state.alreadySaved) setRecovery({ opening: current, message: ALREADY_SAVED_MESSAGE, blocked: true, busy: false })
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
      if (opening && state?.opening === opening && state.committed) forget(state, opening)
    }
    // resume/forget only read refs and module state; the opening is the only trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening])

  // While a request may have committed, its exact payload stays locked in the form, through
  // Refresh too: Refresh only re-reads the row and never releases the frozen payload.
  const frozenFor = (current: O): WorkflowReconciliation | undefined => {
    const state = submission.current
    return state?.opening === current && state.uncertain && state.payload ? { command: current.action, payload: state.payload } : undefined
  }

  /** The committed path shared by a normal answer and an already-saved Refresh. */
  const finishCommitted = async (current: O, input: Record<string, Json>, result: Extract<CommandResult, { ok: true }>) => {
    if (submission.current?.opening === current) { submission.current.committed = true; submission.current.definite = false }
    const state = submission.current?.opening === current ? submission.current : null
    const dripFailure = "dripFailure" in result && result.dripFailure ? `Outcome saved. Drip not started: ${result.dripFailure}` : null
    setRecovery(null)
    const committed: AttemptCommitted<O> = { opening: current, input, result, dripFailure }
    // The host publishes its refresh barrier before the dialog can close so a
    // rapid next click is initialized from authorized post-command metadata.
    const read = callbacks.current.onCommitted(committed)
    // A saved attempt (or handoff) keeps its dialog open for the optional
    // drip step, whatever the outcome. Other actions end with the save.
    const keepsOpen = current.action === "log-attempt" || current.action === "handoff"
    if (!keepsOpen) {
      callbacks.current.onClose(current)
      // This result is the confirmed terminal outcome for the opening.
      if (state) forget(state, current)
      submission.current = null
      await read
      callbacks.current.onSettled(committed)
    } else {
      // Kept until the dialog closes (see the opening effect's cleanup).
      if (state) persist(state, current)
      void read.then(() => callbacks.current.onSettled(committed))
    }
  }

  const recover = async () => {
    const current = opening
    if (!current || recovery?.busy) return
    setRecovery({ opening: current, message: "Checking current lead access…", blocked: true, busy: true, reconciliation: frozenFor(current) })
    try {
      const earlier = submission.current
      if (earlier?.opening === current && earlier.alreadySaved) {
        // Verified, not assumed: the server must hold a receipt for this key, this operation,
        // this viewer, this lead and this episode.
        const verified = await loadMyLeadCommandReceipt({
          idempotencyKey: earlier.key, operation: DB_OPERATION[earlier.route ?? ""] ?? "",
          propertyId: current.row.propertyId, episodeId: current.row.assignmentEpisodeId,
        })
        if (activeOpening.current !== current) return
        if (!verified.ok) {
          setRecovery({ opening: current, message: verified.message, blocked: true, busy: false })
          return
        }
        const state = earlier
        state.alreadySaved = false
        state.uncertain = false
        const keepsOpen = current.action === "log-attempt" || current.action === "handoff"
        const followUp = verified.receipt.followUp ? { status: verified.receipt.followUp.status, message: null } : null
        // For an attempt or handoff the drip step / follow-up status continues: the next Save
        // sends nothing and moves the dialog on, instead of silently closing.
        if (keepsOpen) { state.savedEarlier = true; state.savedFollowUp = followUp }
        const result: Extract<CommandResult, { ok: true }> = followUp
          ? { ok: true, attemptRecorded: verified.receipt.attemptRecorded, followUp }
          : { ok: true, ...(verified.receipt.attemptRecorded ? { attemptRecorded: true as const } : {}) }
        await finishCommitted(current, state.payload ?? {}, result)
        if (keepsOpen && activeOpening.current === current) {
          const label = followUp ? ` Follow-up text status: ${followUp.status.replaceAll("_", " ")}.` : ""
          setRecovery({ opening: current, message: SAVED_EARLIER_MESSAGE + label, blocked: false, busy: false })
        }
        return
      }
      const row = await readRow(current)
      if (activeOpening.current !== current) return
      // Never move a retained draft into a different assignment episode.
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
      if (activeOpening.current === current) setRecovery({ opening: current, message: "Could not refresh this lead. Your draft is retained. Try Refresh again.", blocked: true, busy: false, reconciliation: frozenFor(current), canStartOver: (submission.current?.opening === current && submission.current.definite) || undefined })
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
    persist(state, current)
    setRecovery({ opening: current, message: RESUME_NOTICE, blocked: false, busy: false })
  }

  const confirmClose = useCallback(() => {
    const state = submission.current
    const risky = Boolean(opening && state?.opening === opening && !state.committed && (state.uncertain || state.alreadySaved))
    if (!risky || typeof window === "undefined") return true
    return window.confirm(CLOSE_CONFIRM_MESSAGE)
  }, [opening])

  const submit = useCallback(async (payload: object) => {
    if (!opening) return { ok: false as const, message: "Select a lead first." }
    if (recovery?.opening === opening && (recovery.blocked || recovery.busy)) return { ok: false as const, message: recovery.message }
    // A key's request is first sent once; an earlier confirmed save only moves the dialog on.
    if (submission.current?.opening === opening && submission.current.savedEarlier) {
      const followUp = submission.current.savedFollowUp
      submission.current.savedEarlier = false
      setRecovery(null)
      return followUp
        ? { ok: true as const, attemptRecorded: opening.action === "log-attempt", followUp }
        : { ok: true as const, ...(opening.action === "log-attempt" ? { attemptRecorded: true as const } : {}) }
    }
    const row = recoveredRow.current?.opening === opening ? recoveredRow.current.row : opening.row
    // A command's idempotency key belongs to the opening, not to the current
    // draft contents. Before the RPC is known to have crossed its boundary, a
    // definite rejection may be retried with refreshed queue metadata. Once transport
    // or confirmation is uncertain, the original payload and key become one
    // immutable replay pair, so an edited draft cannot produce an idempotency conflict.
    if (submission.current?.opening !== opening) submission.current = { opening, key: crypto.randomUUID(), payload: null, uncertain: false, route: null, memberId: null, atRisk: false, createdAt: Date.now() }
    const state = submission.current
    const command = opening.action as Parameters<typeof submitMyLeadCommand>[0]
    const frozen = state.uncertain && state.payload
    const wantedRoute = routeOf(command, JSON.parse(JSON.stringify(payload)) as Record<string, Json>)
    // Never send the key down another operation. When nothing under the key can have committed
    // (its first send was definitely rejected), a different route simply starts a new key.
    if (state.route !== null && (state.route !== wantedRoute || state.memberId !== memberId) && !frozen) {
      if (state.atRisk) return { ok: false as const, certainty: "rejected" as const, message: ROUTE_CHANGED_MESSAGE }
      forget(state, opening)
      state.key = crypto.randomUUID()
      state.route = null
      state.memberId = null
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
    state.payload = input
    // From here the request may reach Postgres: record the key (and the payload, in memory only)
    // BEFORE sending, so a close, unmount or reload mid-flight cannot lose it.
    const wasAtRisk = state.atRisk
    state.atRisk = true
    state.definite = false
    persist(state, opening)
    const markUncertain = (message?: string) => {
      state.uncertain = true
      state.atRisk = true
      persist(state, opening)
      if (activeOpening.current === opening) setRecovery({ opening, message: message ?? UNCONFIRMED_MESSAGE, blocked: false, busy: false, reconciliation: { command, payload: state.payload ?? input } })
    }
    const applyFailure = (failure: Failure) => {
      // A save that is already confirmed committed is not changed by a late, older answer.
      if (state.committed) return
      const definite = failure.certainty === "rejected" || Boolean(failure.answered && failure.code && DETERMINISTIC_VALIDATION_CODES.has(failure.code))
      if (failure.code === "IDEMPOTENCY_CONFLICT") {
        // A receipt exists for this key, so the save already went through. Never loop,
        // never rotate the key: block with plain copy until a verified lookup succeeds.
        state.alreadySaved = true
        persist(state, opening)
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
          persist(state, opening)
          if (activeOpening.current === opening) setRecovery({ opening, message: CANT_SAVE_MESSAGE, blocked: false, busy: false, reconciliation: { command, payload: state.payload ?? input }, canStartOver: true })
          return
        }
        // Nothing earlier existed under this key (or it is still at risk from before this send).
        state.atRisk = wasAtRisk
        persist(state, opening)
        if ((failure.code === "FORBIDDEN" || failure.code === "STALE_STATE") && activeOpening.current === opening)
          setRecovery({ opening, message: failure.message, blocked: true, busy: false })
        else setRecovery((current) => (current?.opening === opening && current.reconciliation ? null : current))
      } else {
        // Unknown outcome (transport/auth errors, missing confirmation, unexpected
        // exceptions): the request may have committed, so keep it frozen for replay.
        // Actionable guidance from the server (an expired session) is shown as is.
        markUncertain(failure.code === "UNAUTHENTICATED" ? failure.message : undefined)
        if ((failure.code === "FORBIDDEN" || failure.code === "STALE_STATE") && activeOpening.current === opening)
          setRecovery({ opening, message: failure.message, blocked: true, busy: false, reconciliation: { command, payload: state.payload ?? input } })
      }
    }
    const send = (): Promise<CommandResult> => Promise.resolve(command === "handoff" && typeof input.sequenceId === "string" && input.sequenceId
      ? submitMyLeadHandoffDrip({ memberId: sendMember ?? memberId, propertyId: row.propertyId, sequenceId: input.sequenceId,
          reason: "not_interested", expectedEpisodeId: typeof input.expectedEpisodeId === "string" ? input.expectedEpisodeId : row.assignmentEpisodeId,
          expectedQueueVersion: typeof input.expectedQueueVersion === "number" ? input.expectedQueueVersion : row.queueVersion,
          expectedSharedStatus: typeof input.expectedSharedStatus === "string" ? input.expectedSharedStatus : row.sharedStatus,
          idempotencyKey: state.key })
      : submitMyLeadCommand(command, input))
    const call = send()
    let result: CommandResult
    try {
      result = await withSaveTimeout(call, saveTimeoutMs)
    } catch (error) {
      // A rejected server action can mean the request reached Postgres but its
      // response did not reach the browser. Retain the exact request so the
      // next click is a server-side replay instead of a second mutation.
      if (!state.committed) markUncertain()
      // A late answer from this timed-out request is deliberately ignored: a Reconcile replay
      // of the frozen request returns the stored result (duplicate) through the normal path.
      throw error
    }
    if (!result.ok) applyFailure(result as Failure)
    else await finishCommitted(opening, input, result)
    return result
    // finishCommitted only reads refs and state setters, so it is deliberately not a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opening, recovery, memberId, saveTimeoutMs])

  const recoveryValue: AttemptRecoveryValue | null = recovery?.opening === opening
    ? { message: recovery.message, blocked: recovery.blocked, busy: recovery.busy, reconciliation: recovery.reconciliation, refresh: () => void recover(), confirmClose,
        ...(recovery.canStartOver ? { startOver } : {}) }
    : null

  return { submit, recoveryValue, onDripChanged, confirmClose }
}
