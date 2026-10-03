"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import type { QueueRow } from "@/lib/my-leads/queries"
import type { Json } from "@/lib/supabase/types"
import { submitMyLeadCommand, submitMyLeadHandoffDrip } from "../actions"
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
}

export type AttemptRecoveryValue = {
  message: string
  blocked: boolean
  busy: boolean
  refresh: () => void
  reconciliation?: WorkflowReconciliation
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
}

/** Which server operation a command reaches; frozen with the key at the first send. */
function routeOf(command: string, input: Record<string, Json>): string {
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

const UNCONFIRMED_MESSAGE = "Sandra could not confirm this save. The original request is preserved for reconciliation."
const ROUTE_CHANGED_MESSAGE = "This change would save a different kind of update than the one already started. Cancel and start over to make it."
const SAVED_EARLIER_MESSAGE = "Saved earlier. Your update is recorded."

type Failure = { message: string; code?: string; certainty?: "rejected" | "unknown"; answered?: boolean }

export type UseAttemptWorkflowOptions<O extends AttemptOpening> = {
  /** The currently open dialog, or null. */
  opening: O | null
  memberId: string
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
 */
export function useAttemptWorkflow<O extends AttemptOpening>({
  opening, memberId, readRow, onCommitted, onSettled, onClose, onDripChanged, saveTimeoutMs = SAVE_TIMEOUT_MS,
}: UseAttemptWorkflowOptions<O>) {
  const submission = useRef<Submission | null>(null)
  const activeOpening = useRef(opening)
  const callbacks = useRef({ onCommitted, onSettled, onClose, onDripChanged })
  useEffect(() => { activeOpening.current = opening; callbacks.current = { onCommitted, onSettled, onClose, onDripChanged } })
  const recoveredRow = useRef<{ opening: O; row: QueueRow } | null>(null)
  const [recovery, setRecovery] = useState<Recovery<O> | null>(null)

  // While a request may have committed, its exact payload stays locked in the form, through
  // Refresh too: Refresh only re-reads the row and never releases the frozen payload.
  const frozenFor = (current: O): WorkflowReconciliation | undefined => {
    const state = submission.current
    return state?.opening === current && state.uncertain && state.payload ? { command: current.action, payload: state.payload } : undefined
  }

  /** The committed path shared by a normal answer and an already-saved Refresh. */
  const finishCommitted = async (current: O, input: Record<string, Json>, result: Extract<CommandResult, { ok: true }>) => {
    if (submission.current?.opening === current) submission.current.committed = true
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
      submission.current = null
      await read
      callbacks.current.onSettled(committed)
    } else void read.then(() => callbacks.current.onSettled(committed))
  }

  const recover = async () => {
    const current = opening
    if (!current || recovery?.busy) return
    setRecovery({ opening: current, message: "Checking current lead access…", blocked: true, busy: true, reconciliation: frozenFor(current) })
    try {
      const row = await readRow(current)
      if (activeOpening.current !== current) return
      const state = submission.current
      if (state?.opening === current && state.alreadySaved) {
        // The lookup succeeded, so the saved change is visible: run the committed path.
        state.alreadySaved = false
        state.uncertain = false
        const keepsOpen = current.action === "log-attempt" || current.action === "handoff"
        // For an attempt or handoff the drip step / follow-up status continues: the next Save
        // sends nothing and moves the dialog on, instead of silently closing.
        if (keepsOpen) state.savedEarlier = true
        const result = { ok: true as const, ...(current.action === "log-attempt" ? { attemptRecorded: true as const } : {}) }
        await finishCommitted(current, state.payload ?? {}, result)
        if (keepsOpen && activeOpening.current === current) setRecovery({ opening: current, message: SAVED_EARLIER_MESSAGE, blocked: false, busy: false })
        return
      }
      // Never move a retained draft into a different assignment episode.
      if (!row || row.assignmentEpisodeId !== current.row.assignmentEpisodeId) {
        setRecovery({ opening: current, message: "This lead is unavailable in this queue or its assignment changed. Your draft is retained; copy it before closing. Reopen the lead from the current queue to start a new update.", blocked: true, busy: false, reconciliation: frozenFor(current) })
        return
      }
      // Refreshing an opening after a stale response does not start a new
      // submission. Keep its idempotency key so retrying the same command is
      // safe even when the draft was edited while the dialog was blocked.
      recoveredRow.current = { opening: current, row }
      setRecovery({ opening: current, message: "Lead refreshed. Your draft is retained. Review it before saving.", blocked: false, busy: false, reconciliation: frozenFor(current) })
    } catch {
      if (activeOpening.current === current) setRecovery({ opening: current, message: "Could not refresh this lead. Your draft is retained. Try Refresh again.", blocked: true, busy: false, reconciliation: frozenFor(current) })
    }
  }

  const submit = useCallback(async (payload: object) => {
    if (!opening) return { ok: false as const, message: "Select a lead first." }
    if (recovery?.opening === opening && (recovery.blocked || recovery.busy)) return { ok: false as const, message: recovery.message }
    // A key's request is first sent once; an earlier confirmed save only moves the dialog on.
    if (submission.current?.opening === opening && submission.current.savedEarlier) {
      submission.current.savedEarlier = false
      setRecovery(null)
      return { ok: true as const, ...(opening.action === "log-attempt" ? { attemptRecorded: true as const } : {}) }
    }
    const row = recoveredRow.current?.opening === opening ? recoveredRow.current.row : opening.row
    // A command's idempotency key belongs to the opening, not to the current
    // draft contents. Before the RPC is known to have crossed its boundary, a
    // definite rejection may be retried with refreshed queue metadata. Once transport
    // or confirmation is uncertain, the original payload and key become one
    // immutable replay pair, so an edited draft cannot produce an idempotency conflict.
    if (submission.current?.opening !== opening) submission.current = { opening, key: crypto.randomUUID(), payload: null, uncertain: false, route: null, memberId: null }
    const state = submission.current
    const command = opening.action as Parameters<typeof submitMyLeadCommand>[0]
    const nextInput = JSON.parse(JSON.stringify({ ...payload, propertyId: row.propertyId, expectedEpisodeId: row.assignmentEpisodeId,
      expectedQueueVersion: row.queueVersion, expectedSharedStatus: row.sharedStatus, idempotencyKey: state.key })) as Record<string, Json>
    const frozen = state.uncertain && state.payload
    const input = frozen ? state.payload! : nextInput
    // Freeze the route and member with the key at the first send; never send the key down another operation.
    const route = routeOf(command, input)
    if (state.route !== null && (state.route !== route || state.memberId !== memberId) && !frozen)
      return { ok: false as const, certainty: "rejected" as const, message: ROUTE_CHANGED_MESSAGE }
    state.route ??= route
    state.memberId ??= memberId
    const sendMember = state.memberId
    // Keep the reconciliation receipt mounted while the exact original request is replayed.
    if (!(recovery?.opening === opening && recovery.reconciliation)) setRecovery(null)
    state.payload = input
    const markUncertain = (message?: string) => {
      state.uncertain = true
      if (activeOpening.current === opening) setRecovery({ opening, message: message ?? UNCONFIRMED_MESSAGE, blocked: false, busy: false, reconciliation: { command, payload: state.payload ?? input } })
    }
    const applyFailure = (failure: Failure) => {
      // A save that is already confirmed committed is not changed by a late, older answer.
      if (state.committed) return
      if (failure.code === "IDEMPOTENCY_CONFLICT") {
        // A receipt exists for this key, so the save already went through. Never loop,
        // never rotate the key: block with plain copy until a lookup succeeds.
        state.alreadySaved = true
        if (activeOpening.current === opening) setRecovery({ opening, message: failure.message, blocked: true, busy: false })
      } else if (failure.certainty === "rejected" || (failure.answered && !state.uncertain)) {
        // (An answered failure on a first send, with nothing frozen, could not have committed: no
        // earlier send under this key exists. It is shown as the server's field error, not frozen.)
        // The server proved nothing committed under this key. An unresolved replay is
        // over: drop the frozen payload so refreshed preconditions build a NEW payload on
        // the next save. The key and route are KEPT: no receipt exists after a rollback, so
        // reuse cannot conflict, while a late original commit then conflicts instead of
        // recording a second attempt.
        if (state.uncertain) { state.uncertain = false; state.payload = null }
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
      markUncertain()
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
    ? { message: recovery.message, blocked: recovery.blocked, busy: recovery.busy, reconciliation: recovery.reconciliation, refresh: () => void recover() }
    : null

  return { submit, recoveryValue, onDripChanged }
}
