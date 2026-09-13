import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { formatDuration, MyLeadsMetrics } from "./metrics"
import type { MyLeadsKpis } from "./types"

const kpis: MyLeadsKpis = { attempts: 0, reached: 0, offersSent: 0, contactWithoutFollowUp: 2, needsOffers: 3, appointmentsOverdue: 4, lastAttemptAt: null, asOf: "2026-09-13T15:00:00Z", missingRecordings: 1, recordingExpectationUnknown: 2, averageTalkSeconds: null, talkTimeSamples: 0, talkTimeUnknown: 3, conversationsOverFiveMinutes: 0 }
afterEach(() => {cleanup(); vi.useRealTimers()})
it("renders the nine agreed cards and discloses excluded duration and recording evidence", () => {
  render(<MyLeadsMetrics kpis={kpis} />)
  expect(screen.getAllByTestId(/^kpi-/)).toHaveLength(9)
  expect(screen.getByTestId("kpi-contacts")).toHaveTextContent("0 / 0")
  expect(screen.getByTestId("kpi-average-talk-time")).toHaveTextContent("—")
  expect(screen.getByTestId("kpi-average-talk-time")).toHaveTextContent("3 without duration excluded")
  expect(screen.getByTestId("kpi-missing-recordings")).toHaveTextContent("2 with unknown expectation excluded")
  expect(screen.getByTestId("kpi-last-attempt")).toHaveTextContent("No attempts yet")
})
it("ticks elapsed time across previous days and resets to fresh server evidence", () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "performance"] })
  const view = render(<MyLeadsMetrics kpis={{...kpis, lastAttemptAt: "2026-09-12T14:59:00Z"}} />)
  expect(screen.getByTestId("kpi-last-attempt")).toHaveTextContent("1d 0h 1m")
  view.rerender(<MyLeadsMetrics kpis={{...kpis, lastAttemptAt: "2026-09-13T14:59:00Z"}} />)
  act(() => {vi.advanceTimersByTime(2000)})
  expect(screen.getByTestId("kpi-last-attempt")).toHaveTextContent("1m 2s")
  expect(screen.getByTestId("kpi-last-attempt").querySelector("time")).toHaveAttribute("dateTime", "2026-09-13T14:59:00Z")
})
it("formats duration without negative time or raw seconds", () => {
  expect(formatDuration(-1)).toBe("0m 0s")
  expect(formatDuration(222)).toBe("3m 42s")
  expect(formatDuration(3601)).toBe("1h 0m 1s")
})

it("preserves legacy metrics while new RPC fields are unavailable during rollout", () => {
  const legacy = {attempts: 25, reached: 8, offersSent: 3} as MyLeadsKpis
  const {container} = render(<MyLeadsMetrics kpis={legacy} />)
  expect(screen.getByRole("status")).toHaveTextContent("Some metrics are temporarily unavailable")
  expect(screen.getByTestId("kpi-contacts")).toHaveTextContent("8 / 25")
  expect(screen.getByTestId("kpi-offers-sent")).toHaveTextContent("3")
  for (const id of ["contact-without-follow-up", "needs-offers", "appointments-overdue", "last-attempt", "missing-recordings", "average-talk-time", "conversations-over-five-minutes"]) {
    expect(screen.getByTestId(`kpi-${id}`)).toHaveTextContent("—")
  }
  expect(screen.getByTestId("kpi-average-talk-time")).toHaveTextContent("Talk time unavailable")
  expect(screen.getByTestId("kpi-missing-recordings")).toHaveTextContent("Recording coverage unavailable")
  expect(container).not.toHaveTextContent(/undefined|NaN|No attempts yet/)
})
