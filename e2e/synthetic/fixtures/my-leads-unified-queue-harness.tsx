import { useEffect, useRef } from "react"
import { createRoot } from "react-dom/client"
import { queueRowFixture } from "../../../src/app/(dashboard)/my-leads/_components/call-next-test-support"
import type { MyLeadDetailPageResult } from "../../../src/app/(dashboard)/my-leads/_components/types"
import type { UnifiedInitial, WorkFacts, WorkQuery } from "../../../src/app/(dashboard)/my-leads/unified/contract"
import { parseWorkQuery, workQueryToSearchParams } from "../../../src/app/(dashboard)/my-leads/unified/query-params"
import { UnifiedQueue, type UnifiedQueueActions, type UnifiedQueueHandle } from "../../../src/app/(dashboard)/my-leads/unified/unified-queue"
import { makeServer } from "../../../src/app/(dashboard)/my-leads/unified/work-queue-fixtures"
import { workFacts } from "../../../src/app/(dashboard)/my-leads/unified/test-support"

// A database-free stand-in for fn_my_leads_work_page / fn_my_leads_work_facts: every read rebuilds an
// in-memory server from `defs`, so the spec can change the data and watch the queue react.
const NAMES = ["Alex Taylor", "Sam Rivera", "Jordan Lee", "Pat Morgan", "Kim Park", "Dana Whitfield", "Chris Okafor", "Morgan Diaz", "Riley Brooks", "Taylor Nguyen", "Casey Patel", "Jamie Fox"]
const STREETS = ["Maple Street", "Elm Court", "Oak Avenue", "Birch Road", "Cedar Lane", "Pine Street", "Walnut Drive", "Sycamore Way"]
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const ahead = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

let counter = 0
function def(id: string, reason: WorkFacts["reason"], rowNo: string, headline: Record<string, unknown>, over: Partial<WorkFacts> = {}): WorkFacts {
  const n = counter++
  return workFacts(reason, rowNo, headline, {
    propertyId: id,
    row: queueRowFixture(id, {
      homeownerName: NAMES[n % NAMES.length],
      address: `${100 + ((n * 37) % 880)} ${STREETS[n % STREETS.length]}`,
      stage: over.stage ?? "contacted",
    }),
    ...over,
  })
}

const defs: WorkFacts[] = []
const original = new Map<string, WorkFacts>()
const add = (count: number, prefix: string, build: (id: string, i: number) => WorkFacts) => {
  for (let i = 1; i <= count; i++) defs.push(build(`${prefix}${i}`, i))
}
add(8, "nl", (id, i) => def(id, "new_lead", "3", { assignedAt: ago(30 + i * 20), firstCallOverdue: i % 4 === 0 }, { stage: "not_contacted" }))
add(2, "ct", (id, i) => def(id, "call_today", "2", { pinnedAt: ago(90 * i) }))
add(20, "du", (id, i) => def(id, "due", "4", { at: ago(60 * i), soon: false }, { stage: i % 3 === 0 ? "needs_offer" : "contacted" }))
add(6, "nr", (id, i) => def(id, "new_reply", "5", { at: ago(15 * i), kind: "text" }, { latestInbound: { at: ago(15 * i), kind: "text", messageId: `msg-${id}`, handled: false, contactOnly: false } }))
add(3, "br", (id, i) => def(id, "broken", "6", { kind: "drip_stuck", action: "fix_drip", at: ago(200 * i) }, {
  broken: [{ kind: "drip_stuck", action: "fix_drip", at: ago(200 * i), refId: `ref-${id}` }],
  drip: { enrollmentId: `e-${id}`, status: "paused", pauseReason: "provider_failed", name: "Seller follow-up", step: 2, stepsTotal: 4, nextRunAt: null, completedAt: null, lastSentAt: ago(500), healthy: false },
}))
add(3, "of", (id, i) => def(id, "offer", "7", { kind: "ready", since: ago(60 * 24 * i) }, { stage: "needs_offer" }))
add(4, "gq", (id, i) => def(id, "gone_quiet", "14", { kind: "texted_silent", at: ago(60 * 24 * (3 + i)), since: ago(60 * 24 * (3 + i)) }))
add(14, "np", (id) => def(id, "nothing_planned", "15", {}))
add(5, "dr", (id, i) => def(id, "in_drip", "10", { nextRunAt: ahead(60 * 24 * i), scheduledAt: null, callInProgress: false, resumeBy: null }, {
  place: "their_move",
  drip: { enrollmentId: `e-${id}`, status: "active", pauseReason: null, name: "Seller follow-up", step: i, stepsTotal: 6, nextRunAt: ahead(60 * 24 * i), completedAt: null, lastSentAt: ago(60 * 20), healthy: true },
}))
add(3, "tl", (id, i) => def(id, "texted_last", "13", { at: ago(60 * 6 * i), by: "human", until: ahead(60 * 24) }, { place: "their_move" }))
add(2, "oo", (id, i) => def(id, "offer_out", "11", { kind: "offer_out", at: ahead(60 * 24 * i) }, { place: "their_move", stage: "offer_sent" }))
add(2, "cb", (id, i) => def(id, "callback_booked", "11", { kind: "callback_booked", at: ahead(60 * 5 * i) }, { place: "their_move" }))
add(2, "uc", (id, i) => def(id, "under_contract", "1", { signedAt: ago(60 * 24 * i) }, { place: "neither", stage: "under_contract" }))
// One homeowner owns three houses (one another rep's): the row shows "Owns 3 houses".
{
  const i = defs.findIndex((d) => d.propertyId === "nl1")
  defs[i] = {
    ...defs[i],
    homeownerPropertyCount: 3,
    homeownerHouses: {
      count: 3,
      houses: [
        { propertyId: "nl1", address: `${defs[i].row.address}, Kansas City, MO`, assignedUserId: "me", isMine: true },
        { propertyId: "nl1-b", address: "18 Second Home Rd, Olathe, KS", assignedUserId: "me", isMine: true },
        { propertyId: "nl1-c", address: "905 Elm Ct, Lenexa, KS", assignedUserId: "rep-2", isMine: false },
      ],
    },
  }
}
for (const d of defs) original.set(d.propertyId, d)

const matches = (d: WorkFacts, search: string) =>
  !search || `${d.row.homeownerName} ${d.row.address} ${d.row.phone}`.toLowerCase().includes(search.toLowerCase())
function fresh(search = "") {
  const server = makeServer(25)
  for (const d of defs) if (matches(d, search)) server.add(d.propertyId, d)
  return server
}

const log: string[] = []
const note = (entry: string) => {
  log.push(entry)
  const el = document.getElementById("harness-log")
  if (el) el.textContent = log.join("\n")
}

const harness = {
  /** Put a new lead at the top of Needs attention (a background read then sees a changed list). */
  prepend(id: string) {
    defs.unshift(def(id, "new_reply", "5", { at: ago(1), kind: "text" }, { latestInbound: { at: ago(1), kind: "text", messageId: `msg-${id}`, handled: false, contactOnly: false } }))
  },
  set(id: string, patch: Partial<WorkFacts>) {
    const i = defs.findIndex((d) => d.propertyId === id)
    defs[i] = { ...defs[i], ...patch }
  },
  log,
}
;(window as unknown as { __harness: typeof harness }).__harness = harness

const KPIS = {
  attempts: 25, reached: 8, offersSent: 3, contactWithoutFollowUp: 12, needsOffers: 8, appointmentsOverdue: 5, lastAttemptAt: ago(4), lastAttemptClockVersion: 1,
  asOf: new Date().toISOString(), missingRecordings: 2, recordingExpectationUnknown: 4, averageTalkSeconds: 222, talkTimeSamples: 6, talkTimeUnknown: 2,
  conversationsOverFiveMinutes: 4, pendingOutcomes: 0, firstCallSamples: 3, firstCallPending: 2, firstCallElapsedSeconds: 120, appointmentsDue: 1, appointmentsHeld: 2,
  orgAppointmentsUnattributed: 0, staleLeads: 0,
} as never

const actions: UnifiedQueueActions = {
  loadWorkPage: async ({ query }) => ({ ok: true, page: fresh(query.search).page(query) }),
  loadWorkFacts: async ({ ids }) => ({ ok: true, facts: fresh().facts(ids) }),
  pinLead: async ({ propertyId, action }) => {
    note(`pin:${action}:${propertyId}`)
    if (action === "pin") harness.set(propertyId, { reason: "call_today", rowNo: "2", headline: { pinnedAt: new Date().toISOString() } })
    else {
      const base = original.get(propertyId)!
      harness.set(propertyId, { reason: base.reason, rowNo: base.rowNo, headline: base.headline })
    }
    return { ok: true, pinnedAt: action === "pin" ? new Date().toISOString() : null }
  },
  dismissBroken: async ({ propertyId, sourceId }) => {
    note(`dismiss:${propertyId}:${sourceId}`)
    harness.set(propertyId, { broken: [], reason: "nothing_planned", rowNo: "15", headline: {} })
    return { ok: true }
  },
  loadKpis: async () => ({ ok: true, kpis: KPIS }),
}

const url = new URLSearchParams(window.location.search)
const linked = url.get("lead")
const readOnly = url.get("view") === "owner"
let query: WorkQuery = parseWorkQuery(url)
let pinned: WorkFacts | null = null
if (linked) {
  const facts = fresh().facts([linked]).rows[0] ?? null
  if (facts) {
    pinned = facts
    query = { tab: facts.place === "your_move" ? "needs_attention" : facts.place === "their_move" ? "waiting" : "all", chip: "all", stage: null, search: "", page: 1 }
  }
}
const first = fresh(query.search).page(query)
const initial: UnifiedInitial = { query: { ...query, page: first.page }, page: first, error: null, kpis: KPIS, pinned }

function messages(): MyLeadDetailPageResult {
  const row = (id: string, direction: "inbound" | "outbound", body: string, minutes: number) => ({
    id, body, direction, createdAt: ago(minutes), createdLabel: "", deliveryStatus: direction === "outbound" ? "delivered" : "received", attachmentCount: 0,
  })
  return {
    ok: true,
    group: "messages",
    page: {
      rows: [
        row("t3", "inbound", "Yes, that works. Can you call me after 5?", 25),
        row("t2", "outbound", "Hi, this is Maria. Would you consider an offer on the house?", 600),
        row("t1", "outbound", "Hello, is this the owner of the property?", 2000),
      ],
      hasMore: false,
      nextCursor: null,
    },
  }
}

function Harness() {
  // Mirrors client.tsx's address-bar sync: tab/chip/stage/page changes push, search edits and changes the rep did not
  // make replace, and popstate (Back/Forward) hands the parsed URL back to the queue.
  const handle = useRef<UnifiedQueueHandle | null>(null)
  const lastQuery = useRef<WorkQuery | null>(initial.query)
  const syncUrl = (next: WorkQuery, options?: { replace?: boolean }) => {
    const qs = workQueryToSearchParams(next).toString()
    const target = qs ? `/my-leads?${qs}` : "/my-leads"
    const previous = lastQuery.current
    lastQuery.current = next
    const current = `${window.location.pathname}${window.location.search}`
    if (options?.replace || !previous || previous.search !== next.search) window.history.replaceState(null, "", target)
    else if (target !== current) window.history.pushState(null, "", target)
  }
  useEffect(() => {
    const onPopState = () => {
      if (window.location.pathname !== "/my-leads") return
      const query = parseWorkQuery(new URLSearchParams(window.location.search))
      lastQuery.current = query
      handle.current?.syncQuery(query)
    }
    window.addEventListener("popstate", onPopState)
    return () => window.removeEventListener("popstate", onPopState)
  }, [])
  return (
    <>
      <header data-testid="top-nav" className="fixed inset-x-0 top-0 z-40 h-16 bg-slate-900 text-white md:left-64">Top navigation</header>
      <aside data-testid="left-nav" className="fixed inset-y-0 left-0 hidden w-64 bg-slate-900 md:block" />
      <nav className="fixed inset-x-0 top-16 z-30 h-[52px] bg-slate-800 md:hidden" />
      <div className="pt-[116px] md:ml-64 md:pt-16">
        <main className="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-6 font-sans lg:px-8">
          <UnifiedQueue
            initial={initial}
            actions={actions}
            memberId="rep-1"
            canAct={!readOnly}
            canSelectRep={false}
            repOptions={[{ id: "rep-1", label: "Maria" }]}
            selectedRepLabel="Maria"
            onRepChange={() => {}}
            deepLinkId={linked && pinned ? linked : null}
            deepLinkNonce={1}
            onQueryChange={syncUrl}
            registerHandle={(next) => { handle.current = next }}
            onAction={(kind, id) => note(`action:${kind}:${id}`)}
            onLoadDetailPage={async () => messages()}
          />
          <pre data-testid="harness-log" id="harness-log" className="text-xs" />
        </main>
      </div>
    </>
  )
}

createRoot(document.getElementById("root")!).render(<Harness />)
