"use client"

import { useEffect, useRef, useState, type RefObject } from "react"
import { formatDuration } from "./metrics"
import type { MyLeadsKpis } from "./types"

/** Mirrors the expanded cards only after they scroll behind the dashboard navigation. */
export function StickyMyLeadsMetrics({ kpis, expandedRef, repLabel }: {
  kpis: MyLeadsKpis
  expandedRef: RefObject<HTMLDivElement | null>
  repLabel?: string | null
}) {
  const [visible, setVisible] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const stripRef = useRef<HTMLDivElement>(null)
  const clockStart = useRef(0)
  useEffect(() => {
    const expanded = expandedRef.current
    const strip = stripRef.current
    if (!expanded || !strip || typeof IntersectionObserver === "undefined") return
    const observe = () => {
      const inset = Number.parseFloat(getComputedStyle(strip).top)
      return new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1]
        // Edge adjacency is intersecting even with zero area. Hide there;
        // moving farther into view need not produce another observation.
        if (entry) setVisible(!entry.isIntersecting && entry.boundingClientRect.bottom <= inset)
      }, { rootMargin: `-${inset}px 0px 0px 0px` })
    }
    let observer = observe()
    observer.observe(expanded)
    const onResize = () => {
      observer.disconnect()
      observer = observe()
      observer.observe(expanded)
    }
    window.addEventListener("resize", onResize)
    return () => { observer.disconnect(); window.removeEventListener("resize", onResize) }
  }, [expandedRef])
  useEffect(() => {
    clockStart.current = performance.now()
    setElapsed(0)
  }, [kpis.asOf])
  useEffect(() => {
    if (!visible) return
    const tick = () => setElapsed((performance.now() - clockStart.current) / 1000)
    tick()
    const timer = window.setInterval(tick, 1000)
    return () => window.clearInterval(timer)
  }, [visible, kpis.asOf])

  const count = (value: number | undefined) => Number.isFinite(value) ? value : "—"
  const hasSnapshot = typeof kpis.asOf === "string" && Number.isFinite(Date.parse(kpis.asOf))
  const lastAttempt = !hasSnapshot || kpis.lastAttemptAt === undefined ? "—"
    : kpis.lastAttemptAt === null ? "None yet"
      : formatDuration((Date.parse(kpis.asOf) - Date.parse(kpis.lastAttemptAt)) / 1000 + elapsed)
  const metrics = [
    ["No follow-up", count(kpis.contactWithoutFollowUp), "Active Contact leads without a future follow-up appointment"],
    ["Needs offer", count(kpis.needsOffers), "Active leads needing offers"],
    ["Overdue", count(kpis.appointmentsOverdue), "Outstanding overdue appointments, including previous days"],
    ["Last attempt", lastAttempt, "Elapsed since this rep’s latest attempt, including previous days"],
    ["Reaches / attempts", `${count(kpis.reached)} / ${count(kpis.attempts)}`, "Today’s reaches / attempts · Central time"],
    ["Offers sent", count(kpis.offersSent), "Today’s offers sent · Central time"],
    ["Missing recordings", count(kpis.missingRecordings), `Expected recordings unavailable after five minutes · ${count(kpis.recordingExpectationUnknown)} with unknown expectation excluded`],
    ["Avg. talk", kpis.averageTalkSeconds == null ? "—" : formatDuration(kpis.averageTalkSeconds), `${count(kpis.talkTimeSamples)} reached calls with duration · ${count(kpis.talkTimeUnknown)} without duration excluded`],
    ["Over 5 min", count(kpis.conversationsOverFiveMinutes), "Today’s reached calls strictly over five minutes with known talk time"],
  ]
  return <div ref={stripRef} className="sticky top-[116px] z-20 -my-3 h-0 min-w-0 md:top-16">
    {visible && <div role="region" aria-label={`Sticky metrics for ${repLabel || "selected rep"}`} tabIndex={0}
      className="overflow-x-auto overscroll-x-contain rounded-xl border border-border bg-card shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid="sticky-metrics">
      <dl className="flex w-max min-w-full divide-x divide-border">
        {metrics.map(([label, value, detail]) => <div key={label} title={String(detail)} className="relative flex-1 whitespace-nowrap px-3 py-2">
          <dt className="text-[10px] font-semibold text-muted-foreground">{label}</dt>
          <dd className="text-base font-bold tabular-nums">{value}</dd>
          <dd className="sr-only">{detail}</dd>
        </div>)}
      </dl>
    </div>}
  </div>
}
