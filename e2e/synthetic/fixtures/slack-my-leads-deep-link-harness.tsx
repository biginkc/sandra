import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"

import LoginPage from "@/app/(auth)/login/page"
import { MyLeadsClient } from "@/app/(dashboard)/my-leads/client"
import {
  parseSelectedLeadParam,
  selectedLeadUnavailableMessage,
  type SelectedLeadResult,
} from "@/app/(dashboard)/my-leads/deep-link"
import type {
  AcquisitionDetail,
  DetailFact,
  AcquisitionKpis,
  AcquisitionRoster,
  QueueRow,
  QueueSnapshot,
} from "@/lib/my-leads/queries"
import type { MyLeadStage } from "@/app/(dashboard)/my-leads/_components/types"

export const LINKED_LEAD_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
export const SECONDARY_LEAD_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"
export const CURRENT_QUEUE_ID = "11111111-2222-4333-8444-555555555555"

function emptyDetailGroup(): { rows: DetailFact[]; cursor: string | null; hasMore: boolean } {
  return { rows: [], cursor: null, hasMore: false }
}
const viewer = { userId: "owner-a", orgId: "org-synthetic", isOwner: true }

const roster: AcquisitionRoster = {
  isOwner: true,
  members: [
    { id: "owner-a", label: "Owner A", role: "owner", acquisitionsEnabled: true, active: true, hasHistory: true },
    { id: "owner-b", label: "Owner B", role: "member", acquisitionsEnabled: true, active: true, hasHistory: true },
  ],
  settings: { enabled: true, recipientId: null, revision: 1 },
}

const linkedDetail: AcquisitionDetail = {
  groups: {
    messages: {
      ...emptyDetailGroup(),
      rows: [
        { id: "text-3", at: "2026-10-02T20:00:00.000Z", actorId: null, body: "Final check-in before the weekend", direction: "outbound", deliveryStatus: "delivered", attachmentCount: 0 },
        { id: "text-2", at: "2026-10-01T18:00:00.000Z", actorId: null, body: "Yes, Thursday works for me.", direction: "inbound", deliveryStatus: "received", attachmentCount: 0 },
        { id: "text-1", at: "2026-09-30T18:00:00.000Z", actorId: null, body: "Hi — is Thursday still a good time to talk?", direction: "outbound", deliveryStatus: "delivered", attachmentCount: 0 },
      ],
    },
    notes: emptyDetailGroup(),
    attempts: emptyDetailGroup(),
    appointments: emptyDetailGroup(),
    offers: emptyDetailGroup(),
    history: emptyDetailGroup(),
  },
}

const secondaryDetail: AcquisitionDetail = {
  groups: {
    messages: {
      ...emptyDetailGroup(),
      rows: [
        { id: "text-b-1", at: "2026-10-03T20:00:00.000Z", actorId: null, body: "B-only detail is ready.", direction: "inbound", deliveryStatus: "received", attachmentCount: 0 },
      ],
    },
    notes: emptyDetailGroup(),
    attempts: emptyDetailGroup(),
    appointments: emptyDetailGroup(),
    offers: emptyDetailGroup(),
    history: emptyDetailGroup(),
  },
}

function queueRow(
  propertyId: string,
  address: string,
  homeownerName: string,
  stage: MyLeadStage,
): QueueRow {
  return {
    propertyId,
    stage,
    queueVersion: 1,
    sharedStatus: stage === "contacted" ? "contacted" : "new_lead",
    assignmentEpisodeId: "episode-synthetic-1",
    assignedAt: "2026-10-03T14:00:00.000Z",
    initializedAt: "2026-10-03T14:00:00.000Z",
    episodeKind: "live",
    clockEligible: true,
    firstCallAt: stage === "contacted" ? "2026-10-03T14:12:00.000Z" : null,
    stageEnteredAt: "2026-10-03T14:00:00.000Z",
    address,
    city: "Kansas City",
    state: "MO",
    homeownerName,
    phone: "(816) 555-0100",
    contactId: "contact-synthetic-1",
    phones: ["(816) 555-0100"],
    contactDnc: false,
    temperature: null,
    motivationKind: null,
    motivationText: null,
    warningReasons: [],
    nextStepAt: null,
    nextStepType: null,
    offer: null,
    attemptsCount: stage === "contacted" ? 1 : 0,
  }
}

const currentQueueRow = queueRow(CURRENT_QUEUE_ID, "1 Current Queue Road", "Current Queue Seller", "not_contacted")

function queueSnapshot(row = currentQueueRow): QueueSnapshot {
  return {
    stages: {
      not_contacted: { rows: [row], totalCount: 1, filteredCount: 1, cursor: null, hasMore: false },
      contacted: { rows: [], totalCount: 11, filteredCount: 11, cursor: "contacted-next", hasMore: true },
      needs_offer: { rows: [], totalCount: 0, filteredCount: 0, cursor: null, hasMore: false },
      offer_sent: { rows: [], totalCount: 0, filteredCount: 0, cursor: null, hasMore: false },
      under_contract: { rows: [], totalCount: 0, filteredCount: 0, cursor: null, hasMore: false },
    },
    snapshotAt: "2026-10-03T15:00:00.000Z",
    nextWarningAt: null,
    search: "",
  }
}

function kpis(overrides: Partial<AcquisitionKpis> = {}): AcquisitionKpis {
  return {
    contactWithoutFollowUp: 1,
    needsOffers: 0,
    appointmentsOverdue: 0,
    lastAttemptAt: "2026-10-03T14:12:00.000Z",
    lastAttemptClockVersion: undefined,
    asOf: "2026-10-03T15:00:00.000Z",
    missingRecordings: 0,
    recordingExpectationUnknown: 0,
    averageTalkSeconds: 180,
    talkTimeSamples: 1,
    talkTimeUnknown: 0,
    conversationsOverFiveMinutes: 0,
    attempts: 1,
    reached: 1,
    pendingOutcomes: 0,
    firstCallSamples: 1,
    firstCallPending: 0,
    firstCallElapsedSeconds: 720,
    appointmentsDue: 0,
    appointmentsHeld: 0,
    orgAppointmentsUnattributed: 0,
    offersSent: 0,
    staleLeads: 0,
    ...overrides,
  }
}

export type SyntheticSubmitCall = { command: string; input: Record<string, unknown> }
export type SyntheticMyLeadsBackend = {
  linkedRow: QueueRow
  secondaryRow: QueueRow
  rowReads: number
  secondaryDetailPending: boolean
  queueReads: Array<{ memberId: string; search: string; period: string }>
  submitCalls: SyntheticSubmitCall[]
  loadMyLeads(input: { memberId: string; search: string; period: string }): Promise<unknown>
  loadMyLeadQueueRow(input: { memberId: string; propertyId: string }): Promise<unknown>
  loadMyLeadRow(input: { memberId: string; propertyId: string }): Promise<unknown>
  loadMyLeadDetail(input: { memberId: string; propertyId: string }): Promise<unknown>
  loadMyLeadCallReferences(): Promise<unknown>
  submitMyLeadCommand(command: string, input: Record<string, unknown>): Promise<unknown>
  submitMyLeadHandoffDrip(): Promise<unknown>
  releaseSecondaryDetail(): void
}

export function createSyntheticBackend(): SyntheticMyLeadsBackend {
  let releaseSecondaryDetail: (() => void) | null = null
  const backend: SyntheticMyLeadsBackend = {
    linkedRow: queueRow(LINKED_LEAD_ID, "44 Synthetic Link Lane", "Linked Synthetic Seller", "contacted"),
    secondaryRow: queueRow(SECONDARY_LEAD_ID, "99 Deferred Link Lane", "Deferred Synthetic Seller", "contacted"),
    rowReads: 0,
    secondaryDetailPending: false,
    queueReads: [],
    submitCalls: [],
    async loadMyLeads(input) {
      backend.queueReads.push(input)
      return {
        ok: true,
        snapshot: queueSnapshot(),
        kpis: kpis({ needsOffers: backend.linkedRow.stage === "needs_offer" ? 1 : 0, offersSent: backend.linkedRow.stage === "offer_sent" ? 1 : 0 }),
        drips: { active: [], replied: [], repliedCount: 0, counts: { not_contacted: 0, contacted: 0, needs_offer: 0, offer_sent: 0, under_contract: 0 } },
      }
    },
    async loadMyLeadQueueRow(input) {
      backend.rowReads += 1
      const propertyId = input.propertyId.toLowerCase()
      if (![LINKED_LEAD_ID, SECONDARY_LEAD_ID].includes(propertyId)) return { ok: false, message: "This lead is unavailable in your My Leads queue." }
      const row = propertyId === LINKED_LEAD_ID ? backend.linkedRow : backend.secondaryRow
      return { ok: true, lookup: { status: "found", row: { ...row }, snapshotAt: `2026-10-03T15:0${backend.rowReads}:00.000Z` } }
    },
    async loadMyLeadRow(input) {
      return backend.loadMyLeadQueueRow(input)
    },
    async loadMyLeadDetail(input) {
      if (input.propertyId.toLowerCase() === SECONDARY_LEAD_ID) {
        backend.secondaryDetailPending = true
        await new Promise<void>((resolve) => { releaseSecondaryDetail = resolve })
        backend.secondaryDetailPending = false
        return { ok: true, detail: secondaryDetail }
      }
      return { ok: true, detail: linkedDetail }
    },
    async loadMyLeadCallReferences() {
      return { ok: true, options: [] }
    },
    async submitMyLeadCommand(command, input) {
      backend.submitCalls.push({ command, input })
      if (command === "ready-for-offer" && backend.submitCalls.filter(call => call.command === command).length === 1) {
        backend.linkedRow = { ...backend.linkedRow, queueVersion: 2, sharedStatus: "interested", stage: "needs_offer" }
        return { ok: false, certainty: "rejected", code: "STALE_STATE", message: "This lead changed. Refresh before trying again." }
      }
      if (command === "ready-for-offer") {
        backend.linkedRow = { ...backend.linkedRow, queueVersion: 2, sharedStatus: "interested", stage: "needs_offer", motivationKind: "specified", motivationText: "Seller plans to relocate.", temperature: "warm" }
      }
      if (command === "log-offer") {
        backend.linkedRow = { ...backend.linkedRow, queueVersion: 3, sharedStatus: "offer_sent", stage: "offer_sent", offer: { id: "offer-1", amountCents: 12500050, method: "verbal", sentAt: "2026-10-03T15:10:00.000Z", followUpAt: "2026-10-04T15:10:00.000Z", outcome: "pending" } }
      }
      return { ok: true }
    },
    async submitMyLeadHandoffDrip() {
      return { ok: true }
    },
    releaseSecondaryDetail() {
      releaseSecondaryDetail?.()
      releaseSecondaryDetail = null
    },
  }
  return backend
}

function selectedLeadFromLocation(): SelectedLeadResult {
  const params = new URLSearchParams(window.location.search)
  const values = params.getAll("lead")
  const parsed = parseSelectedLeadParam({ lead: values.length === 0 ? undefined : values.length === 1 ? values[0] : values })
  if (parsed.status !== "requested") return parsed
  if (params.get("state") === "unavailable") {
    return {
      status: "unavailable",
      message: selectedLeadUnavailableMessage("access_denied"),
      retryHref: `/my-leads?lead=${encodeURIComponent(parsed.propertyId)}`,
    }
  }
  if (![LINKED_LEAD_ID, SECONDARY_LEAD_ID].includes(parsed.propertyId)) {
    return { status: "unavailable", message: selectedLeadUnavailableMessage("not_found"), retryHref: `/my-leads?lead=${encodeURIComponent(parsed.propertyId)}` }
  }
  const row = parsed.propertyId === LINKED_LEAD_ID
    ? queueRow(LINKED_LEAD_ID, "44 Synthetic Link Lane", "Linked Synthetic Seller", "contacted")
    : queueRow(SECONDARY_LEAD_ID, "99 Deferred Link Lane", "Deferred Synthetic Seller", "contacted")
  return { status: "found", propertyId: parsed.propertyId, row, snapshotAt: "2026-10-03T15:00:00.000Z" }
}

function DeepLinkAcceptanceApp() {
  // Install before child effects run; the production queue requests detail on mount.
  useState(() => {
    const next = createSyntheticBackend()
    window.__sandraSyntheticMyLeadsBackend = next
    return next
  })
  const [selectedLead, setSelectedLead] = useState(() => selectedLeadFromLocation())
  useEffect(() => {
    const onPopState = () => setSelectedLead(selectedLeadFromLocation())
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])

  return (
    <MyLeadsClient
      viewer={viewer}
      roster={roster}
      initialMemberId={viewer.userId}
      initialSnapshot={queueSnapshot()}
      initialKpis={kpis()}
      selectedLead={selectedLead}
      dialpad={{
        connectionId: "synthetic-dialpad",
        allowedOrigins: ["https://dialpad.example.test"],
        binding: { status: "verified", dialpadUserId: "synthetic-user" },
        grants: [],
      }}
    />
  )
}

function App() {
  return window.location.pathname === "/login" ? <LoginPage /> : <DeepLinkAcceptanceApp />
}

declare global {
  interface Window {
    __sandraSyntheticMyLeadsBackend: SyntheticMyLeadsBackend
  }
}

const root = document.getElementById("root")
if (!root) throw new Error("Synthetic My Leads root is missing")
createRoot(root).render(<App />)
