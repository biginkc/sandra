import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { DailyCallClock, dailyCallClockState } from "./daily-call-clock"

const snapshot = { lastAttemptClockVersion: 1 as const, asOf: "2026-09-14T15:00:00Z", lastAttemptAt: "2026-09-14T14:59:00Z" }
const state = (asOf: string, at: string | null = null) => dailyCallClockState({ ...snapshot, asOf, lastAttemptAt: at }, Date.parse(asOf))
afterEach(() => { cleanup(); vi.useRealTimers() })
it("does not count weekends, opening the page, yesterday, invalid or future evidence", () => {
  expect(state("2026-09-13T15:00:00Z", "2026-09-12T17:00:00Z").label).toBe("Outside work hours")
  expect(state("2026-09-12T15:00:00Z").label).toBe("Outside work hours")
  expect(state(snapshot.asOf).label).toBe("No calls today")
  expect(state(snapshot.asOf, "2026-09-11T15:00:00Z").label).toBe("No calls today")
  expect(state(snapshot.asOf, "invalid").label).toBe("Unavailable")
  expect(state(snapshot.asOf, "2026-09-14T15:01:00Z").label).toBe("Unavailable")
  expect(dailyCallClockState({ ...snapshot, lastAttemptClockVersion: undefined }, Date.parse(snapshot.asOf)).label).toBe("—")
})
it("uses Central boundaries and handles daylight saving time", () => {
  expect(state("2026-09-15T01:00:00Z", "2026-09-14T20:00:00Z").label).toBe("Outside work hours")
  expect(state("2026-09-14T13:59:59Z").label).toBe("Outside work hours")
  expect(state("2026-09-14T14:00:00Z", "2026-09-14T13:00:00Z").label).toBe("0m 0s")
  expect(state("2026-09-14T22:00:00Z", snapshot.lastAttemptAt).label).toBe("Outside work hours")
  expect(state("2026-11-02T14:59:59Z").label).toBe("Outside work hours")
  expect(state("2026-11-02T15:00:00Z", "2026-11-02T14:00:00Z").label).toBe("0m 0s")
  expect(state("2026-03-09T14:00:00Z", "2026-03-09T13:00:00Z").label).toBe("0m 0s")
})
it("starts at opening for a same-day pre-shift call and stops at closing without polling while inactive", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
  const view = render(<DailyCallClock kpis={{ ...snapshot, asOf: "2026-09-14T13:59:59Z", lastAttemptAt: "2026-09-14T13:30:00Z" }} />)
  expect(screen.getByText("Outside work hours")).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByText("0m 0s")).toBeInTheDocument()
  view.rerender(<DailyCallClock kpis={{ ...snapshot, asOf: "2026-09-14T21:59:59Z", lastAttemptAt: "2026-09-14T21:59:00Z" }} />)
  expect(screen.getByText("0m 59s")).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(1000))
  expect(screen.getByText("Outside work hours")).toBeInTheDocument()
  act(() => vi.advanceTimersByTime(16 * 60 * 60 * 1000))
  expect(screen.getByText("No calls today")).toBeInTheDocument()
})
it("shares snapshot receipt time when another presentation mounts later and ignores browser wall-clock changes", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] })
  const data = { ...snapshot }
  const view = render(<DailyCallClock kpis={data} />)
  act(() => vi.advanceTimersByTime(2000))
  vi.setSystemTime(new Date("2030-01-01"))
  view.rerender(<><DailyCallClock kpis={data} /><DailyCallClock kpis={data} /></>)
  expect(screen.getAllByText("1m 2s")).toHaveLength(2)
  view.rerender(<DailyCallClock kpis={{ ...snapshot, asOf: "2026-09-14T15:00:02Z", lastAttemptAt: "2026-09-14T15:00:01Z" }} />)
  expect(screen.getByText("0m 1s")).toBeInTheDocument()
})
