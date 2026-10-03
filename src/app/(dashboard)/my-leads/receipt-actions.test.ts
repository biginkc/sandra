import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ viewer: vi.fn(), from: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))
vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from, rpc: vi.fn() }) }))
vi.mock("@/lib/messaging/rep-sms", () => ({ dispatchRepSms: vi.fn(), createRepSmsObligationFence: vi.fn() }))
vi.mock("@/lib/my-leads/queries", () => ({ myLeadsViewer: mocks.viewer, getAcquisitionQueue: vi.fn(), getAcquisitionKpis: vi.fn(), getAcquisitionDetail: vi.fn() }))
vi.mock("@/lib/my-leads/settings", () => ({ setAcquisitionDesignation: vi.fn(), setAcquisitionSettings: vi.fn() }))
import { loadMyLeadCommandReceipt } from "./actions"

type Row = Record<string, unknown>
/** An admin table that applies every .eq() filter to its rows, like PostgREST would. */
function table(rows: Row[], pick: (row: Row) => Row, error: unknown = null) {
  const filters: [string, unknown][] = []
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => { filters.push([column, value]); return chain },
    maybeSingle: async () => {
      if (error) return { data: null, error }
      const found = rows.find((row) => filters.every(([column, value]) => row[column] === value))
      return { data: found ? pick(found) : null, error: null }
    },
  }
  return { chain, filters }
}

const command = (overrides: Row = {}): Row => ({
  org_id: "org-1", actor_user_id: "user-1", operation: "log_acquisition_attempt", idempotency_key: "key-1",
  result: { ok: true, propertyId: "p1", assignmentEpisodeId: "ep-1", attemptId: "att-1" }, ...overrides,
})
const input = { idempotencyKey: "key-1", operation: "log_acquisition_attempt", propertyId: "p1", episodeId: "ep-1" }

function wire(commands: Row[], obligations: Row[] = [], errors: { commands?: unknown; obligations?: unknown } = {}) {
  const c = table(commands, (row) => ({ result: row.result }), errors.commands)
  const o = table(obligations, (row) => ({ state: row.state }), errors.obligations)
  mocks.from.mockImplementation((name: string) => (name === "acquisition_commands" ? c.chain : o.chain))
  return { c, o }
}

describe("loadMyLeadCommandReceipt", () => {
  beforeEach(() => {
    mocks.viewer.mockReset()
    mocks.from.mockReset()
    mocks.viewer.mockResolvedValue({ orgId: "org-1", userId: "user-1", isOwner: false, client: {} })
  })

  it("returns the receipt for a matching org, actor, operation, key, property and episode, with every scope in the query", async () => {
    const { c } = wire([command()])
    expect(await loadMyLeadCommandReceipt(input)).toEqual({ ok: true, receipt: { operation: "log_acquisition_attempt", propertyId: "p1", episodeId: "ep-1", attemptRecorded: true, followUp: null } })
    expect(c.filters).toEqual([["org_id", "org-1"], ["actor_user_id", "user-1"], ["operation", "log_acquisition_attempt"], ["idempotency_key", "key-1"]])
  })

  it("reads the rep SMS obligation status for that attempt, scoped to org, property and actor", async () => {
    const { o } = wire([command()], [{ org_id: "org-1", property_id: "p1", actor_user_id: "user-1", attempt_id: "att-1", state: "delivered" }])
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: true, receipt: { followUp: { status: "delivered" } } })
    expect(o.filters).toEqual([["org_id", "org-1"], ["property_id", "p1"], ["actor_user_id", "user-1"], ["attempt_id", "att-1"]])
  })

  it.each([["claimed", "sending"], ["voided", "unknown"], ["exception_closed", "unknown"], ["accepted", "accepted"]])("maps obligation state %s to follow-up status %s", async (state, status) => {
    wire([command()], [{ org_id: "org-1", property_id: "p1", actor_user_id: "user-1", attempt_id: "att-1", state }])
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: true, receipt: { followUp: { status } } })
  })

  it("does not read obligations for a non-attempt operation", async () => {
    const { o } = wire([command({ operation: "log_acquisition_offer", result: { ok: true, propertyId: "p1", assignmentEpisodeId: "ep-1", offerId: "o1" } })])
    expect(await loadMyLeadCommandReceipt({ ...input, operation: "log_acquisition_offer" })).toMatchObject({ ok: true, receipt: { attemptRecorded: false, followUp: null } })
    expect(o.filters).toEqual([])
  })

  it("a receipt for another property or another episode does not match", async () => {
    wire([command({ result: { ok: true, propertyId: "p-other", assignmentEpisodeId: "ep-1", attemptId: "a" } })])
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "NOT_FOUND" })
    wire([command({ result: { ok: true, propertyId: "p1", assignmentEpisodeId: "ep-other", attemptId: "a" } })])
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("a missing receipt is NOT_FOUND, never success", async () => {
    wire([])
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("a receipt from another organization is not returned", async () => {
    wire([command({ org_id: "org-2" })])
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("a receipt written by another actor is not returned, even for an owner viewing it", async () => {
    wire([command({ actor_user_id: "user-2" })])
    mocks.viewer.mockResolvedValue({ orgId: "org-1", userId: "user-1", isOwner: true, client: {} })
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("a receipt under another operation (route) is not returned", async () => {
    wire([command({ operation: "finalize_acquisition_attempt" })])
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("a stored result that is not a committed success does not count", async () => {
    wire([command({ result: {} })])
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("the drip handoff receipt, which stores no episode id, is bound by property and key", async () => {
    wire([command({ operation: "handoff_acquisition_lead_to_drip", result: { ok: true, propertyId: "p1", queueVersion: 4 } })])
    expect(await loadMyLeadCommandReceipt({ ...input, operation: "handoff_acquisition_lead_to_drip" })).toMatchObject({ ok: true })
    wire([command({ operation: "handoff_acquisition_lead_to_drip", result: { ok: true, propertyId: "p-other", queueVersion: 4 } })])
    expect(await loadMyLeadCommandReceipt({ ...input, operation: "handoff_acquisition_lead_to_drip" })).toMatchObject({ ok: false, code: "NOT_FOUND" })
    // Only that one operation may omit the episode.
    wire([command({ result: { ok: true, propertyId: "p1" } })])
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "NOT_FOUND" })
  })

  it("rejects an unknown operation and empty inputs without touching the database", async () => {
    wire([command()])
    expect(await loadMyLeadCommandReceipt({ ...input, operation: "drop_table" })).toMatchObject({ ok: false, code: "NOT_FOUND" })
    expect(await loadMyLeadCommandReceipt({ ...input, idempotencyKey: "" })).toMatchObject({ ok: false, code: "NOT_FOUND" })
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it("an unauthenticated viewer is FORBIDDEN and nothing is read", async () => {
    mocks.viewer.mockRejectedValue(new Error("No session"))
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "FORBIDDEN" })
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it("a failed read is READ_FAILED (retryable), never success", async () => {
    wire([command()], [], { commands: { message: "boom" } })
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "READ_FAILED" })
    wire([command()], [], { obligations: { message: "boom" } })
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "READ_FAILED" })
    mocks.from.mockImplementation(() => { throw new Error("admin down") })
    expect(await loadMyLeadCommandReceipt(input)).toMatchObject({ ok: false, code: "READ_FAILED" })
  })
})
