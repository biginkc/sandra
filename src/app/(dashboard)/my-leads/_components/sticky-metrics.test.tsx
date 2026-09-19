import { useRef } from "react"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { StickyMyLeadsMetrics } from "./sticky-metrics"

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it("uses the final visibility transition when the observer delivers a batch", () => {
  let notify: IntersectionObserverCallback
  let target: Element
  vi.spyOn(window, "getComputedStyle").mockReturnValue({ top: "64px" } as CSSStyleDeclaration)
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { notify = callback }
    observe(element: Element) { target = element }
    disconnect() {}
  })
  function Harness() {
    const expandedRef = useRef<HTMLDivElement>(null)
    return <><div ref={expandedRef} /><StickyMyLeadsMetrics expandedRef={expandedRef}
      kpis={{ attempts: 0, reached: 0, offersSent: 0, contactWithoutFollowUp: 0,
        needsOffers: 0, appointmentsOverdue: 0, lastAttemptAt: null, asOf: "2026-09-13T08:00:00Z",
        missingRecordings: 0, recordingExpectationUnknown: 0, averageTalkSeconds: null,
        talkTimeSamples: 0, talkTimeUnknown: 0, conversationsOverFiveMinutes: 0 }} /></>
  }
  render(<Harness />)
  const entry = (isIntersecting: boolean, bottom: number, time: number) => ({
    target, isIntersecting, boundingClientRect: { bottom }, time,
  }) as IntersectionObserverEntry
  act(() => notify([entry(false, 63, 1), entry(true, 64, 2)], {} as IntersectionObserver))
  expect(screen.queryByTestId("sticky-metrics")).not.toBeInTheDocument()
  act(() => notify([entry(true, 65, 3), entry(false, 63, 4)], {} as IntersectionObserver))
  expect(screen.getByTestId("sticky-metrics")).toBeVisible()
})
