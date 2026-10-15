import { beforeEach, describe, expect, it, vi } from "vitest"

// Real checkRepSmsReceipt + real rep-sms module (readRepSmsContext, dispatchRepSms). Only the Supabase layer, the
// messaging provider and the outbound send are mocked.
const mocks = vi.hoisted(() => ({ clientRpc: vi.fn(), adminRpc: vi.fn(), send: vi.fn(), provider: vi.fn() }))
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: mocks.clientRpc,
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.or = () => chain
      chain.maybeSingle = () => Promise.resolve({ data: { phone_1: "+18165550123", phone_1_type: "mobile" }, error: null })
      return chain
    },
  }),
}))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.adminRpc, from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) }))
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: vi.fn() }))
vi.mock("@/lib/auth/access-state", () => ({ hasActiveSandraAccess: vi.fn(() => true) }))
vi.mock("@/lib/messaging/providers/sendillo", () => ({ sendilloFromEnvWithOptions: mocks.provider }))
vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: mocks.send }))

import { checkRepSmsReceipt } from "./sms-actions"

const LEDGER = "33333333-3333-4333-8333-333333333333"
const KEY = "11111111-1111-4111-8111-111111111111"
const sender = { id: "s1", number: "+18163706846", label: "Mel", isDefault: true, provider: "sendillo", providerAccountId: "a", providerSenderId: "p", grantStatus: "active", compositionPolicyVersion: 1 }
// The lead ALSO holds a failed (delivery_failed) obligation: the old route through sendRepSms threw on this.
const failedObligation = { id: "obl-9", attemptId: "a9", status: "delivery_failed", messageBody: "x", composition: {}, blockedReason: null, senderAssignmentId: "s1", fromNumber: "+18163706846", toNumber: "+18165550123" }

function setup(state: string) {
  mocks.clientRpc.mockImplementation(async (name: string) => {
    if (name === "fn_get_rep_sms_context") return { data: { orgId: "org-1", actorId: "rep-1", contactId: "c1", provider: "sendillo", senders: [sender], obligation: failedObligation }, error: null }
    if (name === "fn_get_rep_sms_delivery_draft") return { data: { draft: null }, error: null }
    if (name === "fn_get_rep_sms_delivery_target") return { data: { target: { key: KEY, state, body: "b", composition: { remainder: "r" }, assignmentId: "s1", from: "+18163706846", to: "+18165550123" } }, error: null }
    return { data: null, error: { message: "unexpected rpc " + name } }
  })
  mocks.adminRpc.mockResolvedValue({ data: { ok: true, state }, error: null })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv("MESSAGING_PROVIDER", "sendillo")
  vi.stubEnv("SENDILLO_ORG_ID", "org-1")
})

describe("checkRepSmsReceipt", () => {
  it.each(["unknown", "failed_not_dispatched", "delivery_failed", "blocked"])("%s receipt with a coexisting failed obligation: read only, no claim, no send, no provider", async (state) => {
    setup(state)
    const result = await checkRepSmsReceipt({ propertyId: "p1", ledgerId: LEDGER })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.state).toBe(state)
    expect(mocks.clientRpc).toHaveBeenCalledWith("fn_get_rep_sms_delivery_target", { p_property_id: "p1", p_ledger_id: LEDGER })
    const rpcNames = [...mocks.clientRpc.mock.calls, ...mocks.adminRpc.mock.calls].map((c) => c[0])
    expect(rpcNames.some((n) => /claim/.test(n))).toBe(false)
    expect(mocks.adminRpc).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })

  it("a finished (accepted) receipt is acknowledged through the existing non-claiming close, still no send", async () => {
    setup("delivered")
    const result = await checkRepSmsReceipt({ propertyId: "p1", ledgerId: LEDGER })
    expect(result.ok && result.data.acknowledged).toBe(true)
    expect(mocks.adminRpc).toHaveBeenCalledTimes(1)
    expect(mocks.adminRpc.mock.calls[0][0]).toBe("fn_ack_rep_sms_delivery_draft")
    expect(mocks.send).not.toHaveBeenCalled()
    expect(mocks.provider).not.toHaveBeenCalled()
  })

  it("a receipt that is not this actor's/lead's comes back as an error, never a send", async () => {
    setup("unknown")
    mocks.clientRpc.mockImplementation(async (name: string) => (name === "fn_get_rep_sms_delivery_target" ? { data: { target: null }, error: null } : { data: name === "fn_get_rep_sms_context" ? { orgId: "org-1", actorId: "rep-1", contactId: "c1", provider: "sendillo", senders: [sender] } : { draft: null }, error: null }))
    const result = await checkRepSmsReceipt({ propertyId: "p1", ledgerId: LEDGER })
    expect(result.ok).toBe(false)
    expect(mocks.send).not.toHaveBeenCalled()
  })
})
