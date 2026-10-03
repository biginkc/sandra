import { describe, expect, it } from "vitest"

import type { QueueRow } from "./queries"
import { isNewerCopy, newestCopy, pickAuthoritative } from "./authoritative"

const row = (extra: Partial<QueueRow> = {}): QueueRow =>
  ({ propertyId: "p", stage: "contacted", queueVersion: 2, assignmentEpisodeId: "ep-a", assignedAt: "2026-10-01T00:00:00Z", initializedAt: "2026-09-01T00:00:00Z", sharedStatus: "new_lead", ...extra }) as QueueRow
const found = (extra: Partial<QueueRow> = {}) => ({ status: "found" as const, row: row(extra) })

describe("pickAuthoritative", () => {
  it("same episode: the higher queueVersion wins, either way round", () => {
    expect(pickAuthoritative(row({ queueVersion: 2 }), found({ queueVersion: 5 }))).toMatchObject({ source: "lookup", row: { queueVersion: 5 } })
    expect(pickAuthoritative(row({ queueVersion: 6 }), found({ queueVersion: 5 }))).toMatchObject({ source: "list", row: { queueVersion: 6 } })
  })

  it("an older lookup never displaces a newer list row", () => {
    const list = row({ queueVersion: 9 })
    expect(pickAuthoritative(list, found({ queueVersion: 3 })).row).toBe(list)
  })

  it("an exact tie shows the lookup row; among list copies the first stays", () => {
    const lookup = found({ sharedStatus: "interested" })
    expect(pickAuthoritative(row(), lookup).row).toBe(lookup.row)
    const first = row({ sharedStatus: "a" })
    expect(newestCopy([first, row({ sharedStatus: "b" })])).toBe(first)
  })

  it("a different episode: the newer episode wins by assignedAt, falling back to initializedAt", () => {
    const old = row({ assignmentEpisodeId: "ep-a", assignedAt: "2026-10-01T00:00:00Z", queueVersion: 50 })
    const next = found({ assignmentEpisodeId: "ep-b", assignedAt: "2026-10-02T00:00:00Z", queueVersion: 1 })
    expect(pickAuthoritative(old, next).row).toBe(next.row)
    expect(pickAuthoritative(next.row, { status: "found", row: old }).row).toBe(next.row)
    const a = row({ assignmentEpisodeId: "ep-a", assignedAt: null, initializedAt: "2026-09-01T00:00:00Z" })
    const b = row({ assignmentEpisodeId: "ep-b", assignedAt: null, initializedAt: "2026-09-05T00:00:00Z" })
    expect(isNewerCopy(b, a)).toBe(true)
    expect(isNewerCopy(a, b)).toBe(false)
  })

  it("a stage difference alone never decides", () => {
    const list = row({ stage: "offer_sent", queueVersion: 4 })
    expect(pickAuthoritative(list, found({ stage: "not_contacted", queueVersion: 4 })).row?.stage).toBe("not_contacted")
    expect(isNewerCopy(row({ stage: "offer_sent", queueVersion: 4 }), row({ stage: "not_contacted", queueVersion: 4 }))).toBe(false)
  })

  it("uses the lookup row when the list has none", () => {
    expect(pickAuthoritative(null, found())).toMatchObject({ source: "lookup" })
  })

  it("unavailable removes the lead whatever the list or pin hold", () => {
    expect(pickAuthoritative(row({ queueVersion: 99 }), { status: "unavailable" }, row())).toEqual({ row: null, source: "removed" })
  })

  it("a failed lookup prefers any list row over the old pin, and keeps the last good pin only without one", () => {
    const pin = row({ assignmentEpisodeId: "ep-a" })
    const list = row({ assignmentEpisodeId: "ep-b" })
    expect(pickAuthoritative(list, { status: "failed" }, pin)).toEqual({ row: list, source: "list" })
    expect(pickAuthoritative(null, { status: "failed" }, pin)).toEqual({ row: pin, source: "pin" })
    expect(pickAuthoritative(null, { status: "failed" }, null)).toEqual({ row: null, source: "none" })
  })

  it("without a lookup it is the list copy", () => {
    const list = row()
    expect(pickAuthoritative(list, undefined).row).toBe(list)
    expect(pickAuthoritative(null, null).source).toBe("none")
  })

  it("newestCopy picks the newest of several list copies", () => {
    expect(newestCopy([row({ queueVersion: 1 }), row({ queueVersion: 3 }), row({ queueVersion: 2 })])?.queueVersion).toBe(3)
    expect(newestCopy([])).toBeNull()
  })
})
