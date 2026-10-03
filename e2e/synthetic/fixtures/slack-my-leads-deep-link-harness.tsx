import { createRoot } from "react-dom/client"
import { useEffect, useMemo, useState } from "react"

import LoginPage from "@/app/(auth)/login/page"
import { AcquisitionReadinessDialog } from "@/app/(dashboard)/my-leads/_components/readiness-dialog"
import { MyLeadQueueRow } from "@/app/(dashboard)/my-leads/_components/queue-row"
import { MyLeadsQueue } from "@/app/(dashboard)/my-leads/_components/queue"
import { WorkflowRecoveryContext } from "@/app/(dashboard)/my-leads/_components/workflow-form"
import type {
  MyLeadDetail,
  MyLeadDetailPageResult,
  MyLeadDetailState,
  MyLeadQueueRow as MyLeadQueueRowDto,
  MyLeadStage,
  MyLeadsKpis,
  MyLeadsQueueProps,
} from "@/app/(dashboard)/my-leads/_components/types"
import {
  parseSelectedLeadParam,
  selectedLeadUnavailableMessage,
} from "@/app/(dashboard)/my-leads/deep-link"

// The database-free synthetic project cannot run the authenticated page server
// loader or Supabase RLS. Feed its server-shaped result seam into the real
// client-facing queue, row, text strip, readiness dialog, and login components;
// no production auth bypass or direct database fixture is introduced here.
const LINKED_LEAD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const CURRENT_QUEUE_ID = "11111111-2222-4333-8444-555555555555"
const EMPTY_GROUP = { rows: [], hasMore: false, nextCursor: null } as const

const linkedDetail: MyLeadDetail = {
  messages: {
    rows: [
      {
        id: "text-3",
        body: "Final check-in before the weekend ✅",
        direction: "outbound",
        createdAt: "2026-10-02T20:00:00.000Z",
        createdLabel: "Oct 2, 2026",
        deliveryStatus: "delivered",
        attachmentCount: 0,
      },
      {
        id: "text-2",
        body: "Yes, Thursday works for me.",
        direction: "inbound",
        createdAt: "2026-10-01T18:00:00.000Z",
        createdLabel: "Oct 1, 2026",
        deliveryStatus: "received",
        attachmentCount: 0,
      },
      {
        id: "text-1",
        body: "Hi — is Thursday still a good time to talk?",
        direction: "outbound",
        createdAt: "2026-09-30T18:00:00.000Z",
        createdLabel: "Sep 30, 2026",
        deliveryStatus: "delivered",
        attachmentCount: 0,
      },
    ],
    hasMore: false,
    nextCursor: null,
  },
  notes: EMPTY_GROUP,
  attempts: EMPTY_GROUP,
  appointments: EMPTY_GROUP,
  offers: EMPTY_GROUP,
  history: EMPTY_GROUP,
}

function row(
  propertyId: string,
  address: string,
  homeownerName: string,
  queueStage: MyLeadStage,
): MyLeadQueueRowDto {
  return {
    propertyId,
    queueStage,
    address,
    homeownerName,
    phone: "(816) 555-0100",
    assignment: { state: "known", label: "today" },
    firstCall: { state: "started", label: "12 min elapsed" },
    warningReasons: [],
    attemptsCount: 2,
    motivation: {
      temperature: "warm",
      motivationResponseKind: "provided",
      text: "Planning a move this season",
    },
    nextStep: null,
    offer: null,
    archived: false,
  }
}

const linkedRow = row(LINKED_LEAD_ID, "44 Synthetic Link Lane", "Linked Synthetic Seller", "contacted")
const currentQueueRow = row(CURRENT_QUEUE_ID, "1 Current Queue Road", "Current Queue Seller", "not_contacted")

const stages: MyLeadsQueueProps["stages"] = {
  not_contacted: { stage: "not_contacted", rows: [currentQueueRow], totalCount: 1, hasMore: true },
  contacted: { stage: "contacted", rows: [], totalCount: 11, hasMore: true },
  needs_offer: { stage: "needs_offer", rows: [], totalCount: 0, hasMore: false },
  offer_sent: { stage: "offer_sent", rows: [], totalCount: 0, hasMore: false },
  under_contract: { stage: "under_contract", rows: [], totalCount: 0, hasMore: false },
}

const kpis: MyLeadsKpis = {
  attempts: 2,
  reached: 1,
  offersSent: 0,
  contactWithoutFollowUp: 1,
  needsOffers: 0,
  appointmentsOverdue: 0,
  lastAttemptAt: "2026-10-02T20:00:00.000Z",
  lastAttemptClockVersion: undefined,
  asOf: "2026-10-03T15:00:00.000Z",
  missingRecordings: 0,
  recordingExpectationUnknown: 0,
  averageTalkSeconds: 180,
  talkTimeSamples: 1,
  talkTimeUnknown: 0,
  conversationsOverFiveMinutes: 0,
}

function readSearchParams() {
  const params = new URLSearchParams(window.location.search)
  const values = params.getAll("lead")
  return {
    params,
    selected: parseSelectedLeadParam({
      lead: values.length === 0 ? undefined : values.length === 1 ? values[0] : values,
    }),
  }
}

function detailPage(group: keyof MyLeadDetail): MyLeadDetailPageResult {
  return { ok: true, group, page: linkedDetail[group] } as MyLeadDetailPageResult
}

function DeepLinkAcceptanceApp() {
  const [{ params, selected }, setLocation] = useState(readSearchParams)
  const [search, setSearch] = useState("current-only")
  const [selectedRepId, setSelectedRepId] = useState("owner-a")
  const [dialogOpen, setDialogOpen] = useState(false)
  const [submitCount, setSubmitCount] = useState(0)
  const [recovery, setRecovery] = useState<{
    message: string
    blocked: boolean
    busy: boolean
    refresh: () => void
  } | null>(null)
  const [interactionStatus, setInteractionStatus] = useState<string | null>(null)

  useEffect(() => {
    const onPopState = () => setLocation(readSearchParams())
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  const selectedIsUnavailable =
    selected.status === "requested" &&
    (selected.propertyId !== LINKED_LEAD_ID || params.get("state") === "unavailable")

  const detailState: MyLeadDetailState = selected.status === "requested" && selected.propertyId === LINKED_LEAD_ID && !selectedIsUnavailable
    ? { status: "ready", detail: linkedDetail }
    : { status: "loading" }
  const linkedDetailPage = async (group: keyof MyLeadDetail, cursor: string | null) => {
    void cursor
    return detailPage(group)
  }
  const onStageAction = (action: Parameters<NonNullable<MyLeadsQueueProps["onStageAction"]>>[0], target: MyLeadQueueRowDto) => {
    if (target.propertyId !== LINKED_LEAD_ID) return
    if (action === "start-call") {
      setInteractionStatus(`Call request queued for ${target.address}`)
      return
    }
    if (action === "ready-for-offer") {
      setInteractionStatus(null)
      setDialogOpen(true)
    }
  }

  const submitReadiness = async () => {
    if (submitCount === 0) {
      setSubmitCount(1)
      setRecovery({
        message: "This lead changed. Refresh before trying again.",
        blocked: true,
        busy: false,
        refresh: () => setRecovery({
          message: "Lead refreshed. Your draft is retained. Review it before saving.",
          blocked: false,
          busy: false,
          refresh: () => undefined,
        }),
      })
      return { ok: false as const, message: "This lead changed. Refresh before trying again." }
    }
    setRecovery(null)
    setInteractionStatus(`Saved readiness for ${linkedRow.address}`)
    return { ok: true as const }
  }

  const queueProps: MyLeadsQueueProps = useMemo(() => ({
    stages,
    kpis,
    search,
    selectedRepId,
    repOptions: [
      { id: "owner-a", label: "Owner A" },
      { id: "owner-b", label: "Owner B" },
    ],
    canSelectRep: true,
    selectedRepLabel: selectedRepId === "owner-a" ? "Owner A" : "Owner B",
    onSearchChange: setSearch,
    onRepChange: setSelectedRepId,
    onLoadMore: async () => undefined,
    onLoadDetail: async () => ({ ok: true, detail: linkedDetail }),
    onLoadDetailPage: async (_propertyId, group, cursor) => linkedDetailPage(group, cursor),
    onStageAction,
  }), [search, selectedRepId])

  return (
    <main className="mx-auto max-w-[1200px] space-y-5 p-6">
      <header>
        <h1>My Leads</h1>
        <p data-testid="route-state">{window.location.pathname}{window.location.search}</p>
      </header>

      {selected.status === "invalid" && (
        <div role="alert">
          {selected.reason === "duplicate"
            ? "This My Leads link contains more than one lead. Open a link with exactly one lead."
            : "This My Leads link is invalid. Open a link with a valid lead id."}
        </div>
      )}

      {selectedIsUnavailable && selected.status === "requested" && (
        <div role="alert">
          {selectedLeadUnavailableMessage("access_denied")} {" "}
          <a href={`/my-leads?lead=${encodeURIComponent(selected.propertyId)}`}>Retry</a>
        </div>
      )}

      {selected.status === "requested" && !selectedIsUnavailable && selected.propertyId === LINKED_LEAD_ID && (
        <section aria-label="Selected lead from link">
          <p>Opened from a My Leads link</p>
          <MyLeadQueueRow
            row={linkedRow}
            idSuffix="-linked"
            detailsOpen
            detailState={detailState}
            onToggleDetails={() => undefined}
            onRetryDetails={() => undefined}
            onLoadDetailPage={(group, cursor) => linkedDetailPage(group, cursor)}
            onStageAction={onStageAction}
          />
        </section>
      )}

      <label>
        Filter snapshot
        <input aria-label="Synthetic queue filter" value={search} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <MyLeadsQueue {...queueProps} />

      {interactionStatus && <p role="status">{interactionStatus}</p>}

      <WorkflowRecoveryContext.Provider value={recovery}>
        <AcquisitionReadinessDialog
          open={dialogOpen}
          propertyId={linkedRow.propertyId}
          propertyLabel={linkedRow.address}
          initialTemperature={linkedRow.motivation.temperature}
          initialMotivationResponse={null}
          onOpenChange={(open) => {
            setDialogOpen(open)
            if (!open) setRecovery(null)
          }}
          onSubmit={submitReadiness}
        />
      </WorkflowRecoveryContext.Provider>
    </main>
  )
}

function App() {
  return window.location.pathname === "/login" ? <LoginPage /> : <DeepLinkAcceptanceApp />
}

const root = document.getElementById("root")
if (!root) throw new Error("Synthetic My Leads root is missing")
createRoot(root).render(<App />)
