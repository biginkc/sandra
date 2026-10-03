import { describe, expect, it } from "vitest"

import type { QueueRow } from "./queries"
import { isNewerCopy, newestCopy, pickAuthoritative, type Copy } from "./authoritative"

const T1 = "2026-10-01T10:00:00Z"
const T2 = "2026-10-01T10:05:00Z"
const row = (extra: Partial<QueueRow> = {}): QueueRow =>
  ({ propertyId: "p", stage: "contacted", queueVersion: 2, assignmentEpisodeId: "ep-a", assignedAt: "2026-10-01T00:00:00Z", initializedAt: "2026-09-01T00:00:00Z", sharedStatus: "new_lead", ...extra }) as QueueRow
const copy = (extra: Partial<QueueRow> = {}, at: string | null = T1): Copy => ({ row: row(extra), at })
const found = (extra: Partial<QueueRow> = {}, at: string | null = T1) => ({ status: "found" as const, row: row(extra), at })

describe("pickAuthoritative", () => {
  it("same episode: the higher queueVersion wins, either way round", () => {
    expect(pickAuthoritative(copy({ queueVersion: 2 }), found({ queueVersion: 5 }))).toMatchObject({ source: "lookup", row: { queueVersion: 5 } })
    expect(pickAuthoritative(copy({ queueVersion: 6 }), found({ queueVersion: 5 }, T2))).toMatchObject({ source: "list", row: { queueVersion: 6 } })
  })

  it("an older lookup never displaces a newer list row, and a full tie keeps the list copy", () => {
    const list = copy({ queueVersion: 9 })
    expect(pickAuthoritative(list, found({ queueVersion: 3 }, T2)).row).toBe(list.row)
    expect(pickAuthoritative(list, found({ queueVersion: 9 }, T1)).row).toBe(list.row)
  })

  it("equal episode and version: the copy from the newer read wins, whichever side it is on", () => {
    const stale = copy({ sharedStatus: "new_lead" }, T1)
    expect(pickAuthoritative(stale, found({ sharedStatus: "interested" }, T2)).row?.sharedStatus).toBe("interested")
    const freshList = copy({ sharedStatus: "interested" }, T2)
    expect(pickAuthoritative(freshList, found({ sharedStatus: "new_lead" }, T1)).row?.sharedStatus).toBe("interested")
    expect(newestCopy([copy({ sharedStatus: "a" }, T1), copy({ sharedStatus: "b" }, T2), copy({ sharedStatus: "c" }, T1)])?.row.sharedStatus).toBe("b")
  })

  it("an unreadable read time never decides a tie", () => {
    expect(isNewerCopy(copy({}, null), copy({}, T1))).toBe(false)
    expect(isNewerCopy(copy({}, T2), copy({}, "garbage"))).toBe(false)
  })

  it("a different episode: the newer episode wins by assignedAt, falling back to initializedAt", () => {
    const old = copy({ assignmentEpisodeId: "ep-a", assignedAt: "2026-10-01T00:00:00Z", queueVersion: 50 })
    const next = found({ assignmentEpisodeId: "ep-b", assignedAt: "2026-10-02T00:00:00Z", queueVersion: 1 })
    expect(pickAuthoritative(old, next).row).toBe(next.row)
    expect(pickAuthoritative({ row: next.row, at: T1 }, { status: "found", row: old.row, at: T2 }).row).toBe(next.row)
    const a = copy({ assignmentEpisodeId: "ep-a", assignedAt: null, initializedAt: "2026-09-01T00:00:00Z" })
    const b = copy({ assignmentEpisodeId: "ep-b", assignedAt: null, initializedAt: "2026-09-05T00:00:00Z" })
    expect(isNewerCopy(b, a)).toBe(true)
    expect(isNewerCopy(a, b)).toBe(false)
  })

  it("a stage difference alone never decides", () => {
    const list = copy({ stage: "offer_sent", queueVersion: 4 })
    expect(pickAuthoritative(list, found({ stage: "not_contacted", queueVersion: 4 })).row).toBe(list.row)
    expect(pickAuthoritative(copy({ stage: "not_contacted", queueVersion: 4 }), found({ stage: "offer_sent", queueVersion: 4 })).source).toBe("list")
  })

  it("uses the lookup row when the list has none", () => {
    expect(pickAuthoritative(null, found())).toMatchObject({ source: "lookup" })
  })

  it("unavailable removes the lead whatever the list or pin hold", () => {
    expect(pickAuthoritative(copy({ queueVersion: 99 }), { status: "unavailable" }, row())).toEqual({ row: null, source: "removed" })
  })

  it("a failed lookup prefers any list row over the old pin, and keeps the last good pin only without one", () => {
    const pin = row({ assignmentEpisodeId: "ep-a" })
    const list = copy({ assignmentEpisodeId: "ep-b" })
    expect(pickAuthoritative(list, { status: "failed" }, pin)).toEqual({ row: list.row, source: "list" })
    expect(pickAuthoritative(null, { status: "failed" }, pin)).toEqual({ row: pin, source: "pin" })
    expect(pickAuthoritative(null, { status: "failed" }, null)).toEqual({ row: null, source: "none" })
  })

  it("without a lookup it is the list copy", () => {
    const list = copy()
    expect(pickAuthoritative(list, undefined).row).toBe(list.row)
    expect(pickAuthoritative(null, null).source).toBe("none")
  })

  it("newestCopy picks the newest of several list copies", () => {
    expect(newestCopy([copy({ queueVersion: 1 }), copy({ queueVersion: 3 }), copy({ queueVersion: 2 })])?.row.queueVersion).toBe(3)
    expect(newestCopy([])).toBeNull()
  })
})
