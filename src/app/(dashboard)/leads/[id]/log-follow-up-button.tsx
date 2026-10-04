"use client"

import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { AcquisitionAttemptDialog } from "@/app/(dashboard)/my-leads/_components/attempt-dialog"
import { useAttemptWorkflow, type AttemptOpening } from "@/app/(dashboard)/my-leads/_components/use-attempt-workflow"
import { WorkflowRecoveryContext } from "@/app/(dashboard)/my-leads/_components/workflow-form"
import { loadMyLeadCallReferences, loadMyLeadRow } from "@/app/(dashboard)/my-leads/actions"
import { MY_LEAD_ROW_ERROR_COPY, MY_LEAD_ROW_REASON_COPY } from "@/lib/my-leads/row-reasons"
import type { QueueRow } from "@/lib/my-leads/queries"

type Props = {
  propertyId: string
  propertyLabel: string
  /** The rep whose My Leads queue holds this lead. Owners log on that rep's behalf. */
  assigneeId: string | null
  /** Decided at page load: why this viewer cannot log a follow-up, or null when they can. */
  disabledReason: string | null
  /** The signed-in viewer: saved-attempt records are scoped to them. */
  viewer: { userId: string; orgId: string } | null
}

type LogFollowUp = { open: () => void; busy: boolean; message: string | null; disabledReason: string | null; hydrated: boolean }
const LogFollowUpContext = createContext<LogFollowUp | null>(null)

/**
 * Opens the My Leads attempt dialog in place.
 *
 * The state (opening, busy, message) and the dialog live in this PROVIDER, which sits ABOVE the
 * lead hero. The hero re-parents its action buttons when its image falls back (Street View to
 * aerial to flat), which remounts the button; state held in the button was lost with it, so a
 * lookup that finished (or an open dialog) silently vanished. A remounted button now just
 * re-reads this state.
 * The dialog, idempotency and recovery behaviour are the shared My Leads workflow, so a save
 * here is the same command a save there would be.
 */
export function LogFollowUpProvider({ propertyId, propertyLabel, assigneeId, disabledReason, viewer, children }: Props & { children?: ReactNode }) {
  const router = useRouter()
  // Server markup and the pre-hydration client render are disabled, so a click that lands
  // before React attaches its handler can never be silently dropped. The label is unchanged.
  const hydrated = useSyncExternalStore(() => () => {}, () => true, () => false)
  const opening_ = useRef(false)
  const [opening, setOpening] = useState<AttemptOpening | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [callOptions, setCallOptions] = useState<{ opening: AttemptOpening; options: { id: string; label: string }[]; error: string | null } | null>(null)
  const [callRetry, setCallRetry] = useState(0)

  const lookup = useCallback(async (): Promise<{ row: QueueRow } | { message: string }> => {
    if (!assigneeId) return { message: MY_LEAD_ROW_REASON_COPY.unassigned }
    try {
      const result = await loadMyLeadRow({ memberId: assigneeId, propertyId })
      if (!result.ok) return { message: result.code === "NOT_FOUND" ? MY_LEAD_ROW_REASON_COPY.not_found : MY_LEAD_ROW_ERROR_COPY }
      if (result.lookup.status === "unavailable") return { message: MY_LEAD_ROW_REASON_COPY[result.lookup.reason] }
      return { row: result.lookup.row }
    } catch {
      return { message: MY_LEAD_ROW_ERROR_COPY }
    }
  }, [assigneeId, propertyId])

  const workflow = useAttemptWorkflow({
    opening,
    memberId: assigneeId,
    viewer,
    readRow: async () => {
      const result = await lookup()
      if ("row" in result) return result.row
      // A reason means the lead is no longer loggable; a read failure must be retried.
      if (result.message === MY_LEAD_ROW_ERROR_COPY) throw new Error("row read failed")
      return null
    },
    // The page refreshes once, when the save settles.
    onCommitted: () => Promise.resolve(),
    onReconciled: () => {
      router.refresh()
      return Promise.resolve()
    },
    onSettled: ({ dripFailure }) => {
      if (dripFailure) setMessage(dripFailure)
      router.refresh()
    },
    onClose: (closing) => setOpening((current) => (current === closing ? null : current)),
    onDripChanged: () => router.refresh(),
  })

  useEffect(() => {
    if (!opening || !assigneeId) return
    let cancelled = false
    void loadMyLeadCallReferences(propertyId, assigneeId).then((result) => {
      if (!cancelled) setCallOptions({ opening, options: result.ok ? result.options : [], error: result.ok ? null : result.message })
    }).catch(() => {
      if (!cancelled) setCallOptions({ opening, options: [], error: "Could not load Sandra calls." })
    })
    return () => { cancelled = true }
  }, [opening, assigneeId, propertyId, callRetry])

  const open = async () => {
    // A synchronous guard: a second click before the first lookup returns never starts a second opening.
    if (opening_.current || disabledReason) return
    opening_.current = true
    setBusy(true)
    setMessage(null)
    try {
      const result = await lookup()
      if ("row" in result) setOpening({ action: "log-attempt", row: result.row })
      else setMessage(result.message)
    } finally {
      opening_.current = false
      setBusy(false)
    }
  }

  const value: LogFollowUp = { open: () => void open(), busy, message, disabledReason, hydrated }
  return (
    <LogFollowUpContext.Provider value={value}>
      {children}
      <WorkflowRecoveryContext.Provider value={workflow.recoveryValue}>
        {opening && (
          <AcquisitionAttemptDialog
            key={opening.row.assignmentEpisodeId}
            open
            propertyId={propertyId}
            propertyLabel={propertyLabel}
            onOpenChange={(next) => { if (!next) setOpening(null) }}
            onSubmit={(payload) => workflow.submit(payload)}
            onDripChanged={workflow.onDripChanged}
            callReferenceOptions={callOptions?.opening === opening ? callOptions.options : []}
            callReferencesLoading={callOptions?.opening !== opening}
            callReferencesError={callOptions?.opening === opening ? callOptions.error : null}
            onRetryCallReferences={() => setCallRetry((value) => value + 1)}
          />
        )}
      </WorkflowRecoveryContext.Provider>
    </LogFollowUpContext.Provider>
  )
}

/** The button only reads the provider's state, so remounting it (a hero re-parent) loses nothing. */
export function LogFollowUpTrigger() {
  const state = useContext(LogFollowUpContext)
  if (!state) throw new Error("LogFollowUpTrigger must render inside LogFollowUpProvider")
  const { open, busy, message, disabledReason, hydrated } = state
  return (
    <>
      <Button type="button" variant="outline" size="sm" data-testid="log-follow-up-attempt" disabled={Boolean(disabledReason) || busy || !hydrated} aria-busy={busy || undefined}
        title={disabledReason ?? undefined} onClick={open}>
        {busy ? "Opening…" : "Log follow-up"}
      </Button>
      {busy && <span role="status" data-testid="log-follow-up-loading" className="text-xs text-muted-foreground">Loading current lead…</span>}
      {(disabledReason || message) && (
        <span role="status" data-testid="log-follow-up-note" className="text-xs text-muted-foreground">{disabledReason ?? message}</span>
      )}
    </>
  )
}

/** Standalone form (own provider): fine anywhere the surrounding tree never re-parents it. */
export function LogFollowUpButton(props: Props) {
  return (
    <LogFollowUpProvider {...props}>
      <LogFollowUpTrigger />
    </LogFollowUpProvider>
  )
}
