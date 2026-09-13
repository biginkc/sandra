"use client"

import { useEffect, useState } from "react"
import { acquisitionWorkWindow, ACQUISITION_TIME_ZONE } from "@/lib/my-leads/time"
import { getDayBoundsInZone } from "@/lib/time/zoned"
import type { MyLeadsKpis } from "./types"

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—"
  const total = Math.max(0, Math.round(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor(total / 3600) % 24
  const minutes = Math.floor(total / 60) % 60
  const remainder = total % 60
  if (days) return `${days}d ${hours}h ${minutes}m`
  if (hours) return `${hours}h ${minutes}m ${remainder}s`
  return `${minutes}m ${remainder}s`
}

type ClockSnapshot = Pick<MyLeadsKpis, "asOf" | "lastAttemptAt" | "lastAttemptClockVersion">
type ClockState = { label: string; seconds?: number; nextChange?: number }

/** Evaluate the server's evidence against the current Central working day. */
export function dailyCallClockState(snapshot: ClockSnapshot, now: number): ClockState {
  const asOf = Date.parse(snapshot.asOf)
  if (snapshot.lastAttemptClockVersion !== 1 || !Number.isFinite(asOf) || !Number.isFinite(now)
    || snapshot.lastAttemptAt === undefined) return { label: "—" }
  const { dayStart, dayEnd } = getDayBoundsInZone(new Date(now), ACQUISITION_TIME_ZONE)
  const window = acquisitionWorkWindow(new Date(now))
  if (!window || now < window.start || now >= window.end) {
    return { label: "Outside work hours", nextChange: window && now < window.start ? window.start : dayEnd.getTime() }
  }
  if (snapshot.lastAttemptAt === null) return { label: "No calls today", nextChange: window.end }
  const at = Date.parse(snapshot.lastAttemptAt)
  if (!Number.isFinite(at) || at > asOf || at > now) return { label: "Unavailable" }
  if (at < dayStart.getTime() || at >= dayEnd.getTime()) return { label: "No calls today", nextChange: window.end }
  const seconds = (now - Math.max(at, window.start)) / 1000
  return { label: formatDuration(seconds), seconds, nextChange: window.end }
}

// Both presentations receive the same snapshot object. Keep its original browser
// receipt time even when the sticky presentation mounts much later. Weak keys
// allow obsolete snapshots to be collected without retaining rep history.
const anchors = new WeakMap<ClockSnapshot, number>()
const exactTime = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "long", timeZone: ACQUISITION_TIME_ZONE })

export function DailyCallClock({ kpis }: { kpis: ClockSnapshot }) {
  const [tick, setTick] = useState<{ snapshot: ClockSnapshot; now: number } | null>(null)
  const now = tick?.snapshot === kpis ? tick.now : Date.parse(kpis.asOf)
  useEffect(() => {
    let anchor = anchors.get(kpis)
    if (anchor === undefined) { anchor = performance.now(); anchors.set(kpis, anchor) }
    const started = anchor
    const base = Date.parse(kpis.asOf)
    let timer: number | undefined
    const update = () => {
      const current = base + Math.max(0, performance.now() - started)
      setTick({ snapshot: kpis, now: current })
      const state = dailyCallClockState(kpis, current)
      if (state.nextChange !== undefined) {
        const delay = Math.max(1, state.nextChange - current)
        timer = window.setTimeout(update, state.seconds === undefined ? delay : Math.min(1000, delay))
      }
    }
    update()
    return () => window.clearTimeout(timer)
  }, [kpis])
  const state = dailyCallClockState(kpis, now)
  if (state.seconds === undefined) return <>{state.label}</>
  return <time dateTime={kpis.lastAttemptAt!} title={exactTime.format(Date.parse(kpis.lastAttemptAt!))}>{state.label}</time>
}
