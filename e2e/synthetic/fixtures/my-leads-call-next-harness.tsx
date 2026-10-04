import { useState } from "react"
import { createRoot } from "react-dom/client"
import { CallNextStrip } from "../../../src/app/(dashboard)/my-leads/_components/call-next-strip"
import { queueRowFixture, stripItem } from "../../../src/app/(dashboard)/my-leads/_components/call-next-test-support"
import type { CallNextRow, TriageSnapshot } from "../../../src/lib/my-leads/call-next"

const SNAPSHOT_AT = "2026-10-05T15:00:00Z"
const initial: CallNextRow[] = [
  stripItem("overdue", "appointment_overdue", { reasonAt: "2026-10-03T15:00:00Z", row: queueRowFixture("overdue", { homeownerName: "Alex Taylor", address: "123 Maple Street", temperature: "hot" }) }),
  stripItem("inbound", "inbound_text", { reasonAt: "2026-10-05T13:00:00Z", row: queueRowFixture("inbound", { homeownerName: "Sam Rivera", address: "9 Elm Court" }) }),
  stripItem("offer", "offer_follow_up_overdue", { reasonAt: "2026-10-02T15:00:00Z", row: queueRowFixture("offer", { homeownerName: "Jordan Lee", address: "44 Oak Avenue" }) }),
  stripItem("stale", "longest_since_touch", { reasonAt: "2026-09-20T15:00:00Z", row: queueRowFixture("stale", { homeownerName: "Pat Morgan", address: "7 Birch Road" }) }),
]
const triage: TriageSnapshot = {
  rows: [{ propertyId: "old", lastTouchAt: null, row: queueRowFixture("old", { homeownerName: "Kim Park", address: "1 Cedar Lane" }) }],
  totalCount: 1,
  cursor: null,
}

// A stand-in for the database ranking: Call today pins to the top, Not today hides.
function Harness() {
  const [rows, setRows] = useState(initial)
  const [hidden, setHidden] = useState(0)
  const [triageOpen, setTriageOpen] = useState(false)
  const [log, setLog] = useState<string[]>([])
  const note = (entry: string) => setLog((previous) => [...previous, entry])
  return (
    <main className="mx-auto max-w-[1200px] p-4 font-sans">
      <h1 className="mb-6 text-2xl font-bold">My Leads</h1>
      <CallNextStrip
        rows={rows}
        excluded={[{ propertyId: "nophone", address: "5 Pine Street", reason: "no_phone" }]}
        hiddenCount={hidden}
        snapshotAt={SNAPSHOT_AT}
        canAct
        triageOpen={triageOpen}
        triage={triage}
        triageLoading={false}
        triageError={null}
        onToggleTriage={() => setTriageOpen((open) => !open)}
        onLoadMoreTriage={() => {}}
        onCall={(id) => note(`call:${id}`)}
        onCallToday={(id) => {
          note(`call-today:${id}`)
          setRows((previous) => {
            const found = previous.find((r) => r.propertyId === id)
            if (!found) return previous
            return [{ ...found, tier: 0, reason: "pinned_call_today", pinned: true, reasonAt: SNAPSHOT_AT }, ...previous.filter((r) => r.propertyId !== id)]
          })
        }}
        onNotToday={(id) => {
          note(`not-today:${id}`)
          setRows((previous) => previous.filter((r) => r.propertyId !== id))
          setHidden((count) => count + 1)
        }}
        onDeadNurture={(id) => note(`dead-nurture:${id}`)}
      />
      <pre data-testid="harness-log">{log.join("\n")}</pre>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Harness />)
