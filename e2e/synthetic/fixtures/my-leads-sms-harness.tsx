import { useState } from "react"
import { createRoot } from "react-dom/client"
import { MyLeadQueueRow } from "../../../src/app/(dashboard)/my-leads/_components/queue-row"
import type { MyLeadDetail, MyLeadQueueRow as QueueRow, MyLeadSmsMessage } from "../../../src/app/(dashboard)/my-leads/_components/types"

const messages: MyLeadSmsMessage[] = [
  ["outbound", "Hi Alex, would you consider selling your property?"],
  ["inbound", "Possibly. What did you have in mind?"],
  ["outbound", "We can work around your timeline. When would you like to move?"],
  ["outbound", "There is no rush. Happy to answer any questions you have."],
  ["inbound", "I would like to move in November. Can you call tomorrow afternoon?"],
  ["outbound", "Absolutely. Would 2 PM work for you?"],
  ["inbound", "Yes, that works. Here are the details:\nhttps://example.com/" + "property-details-".repeat(35)],
].map(([direction, body], index) => ({
  id: String(index), direction: direction as "inbound" | "outbound", body,
  createdAt: `2026-09-13T18:0${index}:00Z`, createdLabel: `Sep 13, 2026, 1:0${index} PM CDT`,
  deliveryStatus: direction === "outbound" ? "delivered" : "received", attachmentCount: 0,
})).reverse()
const empty = { rows: [], hasMore: false, nextCursor: null }
const row: QueueRow = {
  propertyId: "synthetic-lead", queueStage: "not_contacted", address: "123 Maple Street",
  homeownerName: "Alex Taylor", phone: "555-0100", assignment: { label: "2h ago", state: "known" },
  firstCall: { state: "pending", label: "Awaiting first call" }, warningReasons: [], attemptsCount: 0,
  motivation: { temperature: null, motivationResponseKind: "unanswered", text: null },
  nextStep: null, offer: null, archived: false,
}

function Harness() {
  const [open, setOpen] = useState(true)
  const [detail, setDetail] = useState<MyLeadDetail>({
    messages: { rows: messages, hasMore: true, nextCursor: "older" },
    notes: empty, attempts: empty, appointments: empty, offers: empty, history: empty,
  })
  return <main className="mx-auto max-w-[1200px] p-4 font-sans">
    <h1 className="mb-6 text-2xl font-bold">My Leads</h1>
    <MyLeadQueueRow row={row} detailsOpen={open} detailState={{ status: "ready", detail }}
      onToggleDetails={() => setOpen(!open)} onRetryDetails={() => {}} onStageAction={() => {}}
      onLoadDetailPage={async () => {
        const older = { ...messages[0], id: "earlier", body: "Hello, is this Alex?", direction: "outbound" as const }
        const page = { rows: [older], hasMore: false, nextCursor: null }
        setDetail(previous => ({ ...previous, messages: { ...page, rows: [...previous.messages.rows, older] } }))
        return { ok: true, group: "messages", page }
      }} />
  </main>
}

createRoot(document.getElementById("root")!).render(<Harness />)
