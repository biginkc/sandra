"use client"

import { useEffect, useState, type ReactNode } from "react"
import type { MyLeadsKpis } from "./types"

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total / 3600) % 24
  const minutes = Math.floor(total / 60) % 60
  const remainder = total % 60
  if (days) return `${days}d ${hours}h ${minutes}m`
  if (hours) return `${hours}h ${minutes}m ${remainder}s`
  return `${minutes}m ${remainder}s`
}

const exactTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long", timeZone: "America/Chicago" })

function SinceLastAttempt({ at, asOf }: { at: string | null; asOf: string }) {
  const [now, setNow] = useState(() => Date.parse(asOf))
  useEffect(() => {
    const base = Date.parse(asOf)
    const started = performance.now()
    const timer = window.setInterval(() => setNow(base + performance.now() - started), 1000)
    return () => window.clearInterval(timer)
  }, [asOf])
  if (!at) return <>No attempts yet</>
  const timestamp = Date.parse(at)
  if (!Number.isFinite(timestamp) || !Number.isFinite(now)) return <>Unavailable</>
  return <time dateTime={at} title={exactTime.format(timestamp)}>{formatDuration((now - timestamp) / 1000)}</time>
}

function Metric({ id, label, children, detail }: { id: string; label: string; children: ReactNode; detail?: string }) {
  return <div data-testid={`kpi-${id}`} className="min-w-0 space-y-1.5 bg-card px-4 py-3.5">
    <dt className="text-xs font-semibold text-muted-foreground">{label}</dt>
    <dd className="break-words text-[23px] font-extrabold tracking-tight tabular-nums">{children}</dd>
    {detail && <dd className="text-xs text-muted-foreground">{detail}</dd>}
  </div>
}

export function MyLeadsMetrics({ kpis }: { kpis: MyLeadsKpis }) {
  const coverage = `${kpis.talkTimeSamples} reached calls with duration${kpis.talkTimeUnknown ? ` · ${kpis.talkTimeUnknown} without duration excluded` : ""}`
  return <div className="space-y-4">
    <p className="text-sm text-muted-foreground">All leads for this rep · Unaffected by search or filters</p>
    <section aria-labelledby="my-leads-attention-heading" className="space-y-2">
      <h2 id="my-leads-attention-heading" className="text-sm font-semibold">Needs attention <span className="font-normal text-muted-foreground">· Includes previous days</span></h2>
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
        <Metric id="contact-without-follow-up" label="Contact: no follow-up appointment">{kpis.contactWithoutFollowUp}</Metric>
        <Metric id="needs-offers" label="Leads needing offers">{kpis.needsOffers}</Metric>
        <Metric id="appointments-overdue" label="Overdue appointments">{kpis.appointmentsOverdue}</Metric>
      </dl>
    </section>
    <section aria-labelledby="my-leads-activity-heading" className="space-y-2">
      <h2 id="my-leads-activity-heading" className="text-sm font-semibold">Today’s activity <span className="font-normal text-muted-foreground">· Central time</span></h2>
      <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-border bg-border sm:grid-cols-3">
        <Metric id="last-attempt" label="Since last attempt" detail="Latest attempt, including previous days"><SinceLastAttempt key={kpis.asOf} at={kpis.lastAttemptAt} asOf={kpis.asOf} /></Metric>
        <Metric id="contacts" label="Contacts" detail="Reaches / attempts">{kpis.reached} / {kpis.attempts}</Metric>
        <Metric id="offers-sent" label="Offers sent">{kpis.offersSent}</Metric>
        <Metric id="missing-recordings" label="Missing recordings" detail={`Expected, unavailable after 5 minutes${kpis.recordingExpectationUnknown ? ` · ${kpis.recordingExpectationUnknown} with unknown expectation excluded` : ""}`}>{kpis.missingRecordings}</Metric>
        <Metric id="average-talk-time" label="Average talk time" detail={coverage}>{kpis.averageTalkSeconds === null ? "—" : formatDuration(kpis.averageTalkSeconds)}</Metric>
        <Metric id="conversations-over-five-minutes" label="Conversations > 5 minutes" detail="Reached calls with known talk time">{kpis.conversationsOverFiveMinutes}</Metric>
      </dl>
    </section>
  </div>
}
