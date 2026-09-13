import { useRef } from "react"
import { createRoot } from "react-dom/client"
import { MyLeadsMetrics } from "@/app/(dashboard)/my-leads/_components/metrics"
import { StickyMyLeadsMetrics } from "@/app/(dashboard)/my-leads/_components/sticky-metrics"
const now = new Date().toISOString()
const kpis = { attempts: 25, reached: 8, offersSent: 3, contactWithoutFollowUp: 12, needsOffers: 8, appointmentsOverdue: 5, lastAttemptAt: new Date(Date.now() - 872000).toISOString(), asOf: now, missingRecordings: 2, recordingExpectationUnknown: 4, averageTalkSeconds: 222, talkTimeSamples: 6, talkTimeUnknown: 2, conversationsOverFiveMinutes: 4 }
function Harness() {
  const expandedRef = useRef<HTMLDivElement>(null)
  return <>
    <header data-testid="top-nav" className="fixed inset-x-0 top-0 z-40 h-16 bg-slate-900 text-white md:left-64">Top navigation</header>
    <aside data-testid="left-nav" className="fixed inset-y-0 left-0 hidden w-64 bg-slate-900 md:block" />
    <nav className="fixed inset-x-0 top-16 z-30 h-[52px] bg-slate-800 md:hidden" />
    <div className="pt-[116px] md:ml-64 md:pt-16">
      <main className="mx-auto flex max-w-[1600px] flex-col gap-6 px-4 py-6 lg:px-8">
        <h1>My Leads</h1>
        <div ref={expandedRef} data-testid="expanded-metrics"><MyLeadsMetrics kpis={kpis} /></div>
        <StickyMyLeadsMetrics kpis={kpis} expandedRef={expandedRef} repLabel="Test rep" />
        <div className="space-y-4">{Array.from({length: 30}, (_, index) => <article key={index} className="h-24 rounded border p-4">Lead {index + 1}</article>)}</div>
      </main>
    </div>
  </>
}
createRoot(document.getElementById("root")!).render(<Harness />)
