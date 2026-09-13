import { createRoot } from "react-dom/client"
import { MyLeadsMetrics } from "@/app/(dashboard)/my-leads/_components/metrics"
const now = new Date().toISOString()
createRoot(document.getElementById("root")!).render(<main className="mx-auto max-w-[1600px] space-y-6 p-4 lg:p-8"><h1>My Leads</h1><MyLeadsMetrics kpis={{ attempts: 25, reached: 8, offersSent: 3, contactWithoutFollowUp: 12, needsOffers: 8, appointmentsOverdue: 5, lastAttemptAt: new Date(Date.now() - 872000).toISOString(), asOf: now, missingRecordings: 2, recordingExpectationUnknown: 4, averageTalkSeconds: 222, talkTimeSamples: 6, talkTimeUnknown: 2, conversationsOverFiveMinutes: 4 }} /></main>)
