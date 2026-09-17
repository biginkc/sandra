import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  readContext: vi.fn(),
  dispatch: vi.fn(),
  adminRpc: vi.fn(),
}))

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }))
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.adminRpc }) }))
vi.mock("@/lib/auth/memberships", () => ({ getCallerMembershipsOrThrow: vi.fn() }))
vi.mock("@/lib/auth/access-state", () => ({ hasActiveSandraAccess: vi.fn(() => true) }))
vi.mock("@/lib/messaging/rep-sms", async () => {
  const actual = await vi.importActual<typeof import("@/lib/messaging/rep-sms")>("@/lib/messaging/rep-sms")
  return { ...actual, readRepSmsContext: mocks.readContext, dispatchRepSms: mocks.dispatch }
})

import { sendRepSms } from "./sms-actions"

const composition = {
  introId: "mel-maria-assistant-1",
  introVersion: 1,
  templateId: "no-answer-callback-time",
  templateVersion: 1,
  initialRemainder: "Maria wasn't able to reach you. What time would work for her to call you back?",
  remainder: "Maria wasn't able to reach you. What time would work for her to call you back?",
  initialBody: "Hey, this is Mel, Maria's assistant.\n\nMaria wasn't able to reach you. What time would work for her to call you back?",
}

const baseContext = (status: string) => ({
  orgId: "org-1",
  actorId: "rep-1",
  contactId: "contact-1",
  phone: "+18165550123",
  provider: "sendillo",
  senders: [{ id: "sender-1", number: "+18163706846", label: "Mel", isDefault: true, provider: "sendillo", providerAccountId: "account-1", providerSenderId: "provider-sender-1", grantStatus: "active", compositionPolicyVersion: 1 }],
  obligation: { id: "obligation-1", attemptId: "attempt-1", status, messageBody: composition.initialBody, composition, blockedReason: null, senderAssignmentId: "sender-1", fromNumber: "+18163706846", toNumber: "+18165550123" },
})

beforeEach(() => {
  vi.resetAllMocks()
  mocks.adminRpc.mockResolvedValue({ data: { ok: true, state: "accepted" }, error: null })
})

describe("resumed rep SMS obligations", () => {
  it("strips a forged internal fence from the public generic-send payload", async () => {
    mocks.readContext.mockResolvedValue({ ...baseContext("required"), obligation: null })
    mocks.dispatch.mockResolvedValue({ status: "sent", messageId: "message-1", externalId: "provider-1" })

    const forgedInput = {
      propertyId: "property-1",
      assignmentId: "sender-1",
      composition,
      obligationFence: {
        obligationId: "other-lead-obligation",
        claimToken: "forged-token",
        claimGeneration: 99,
        actorId: "other-rep",
      },
    } as unknown as Parameters<typeof sendRepSms>[0]

    const result = await sendRepSms(forgedInput)

    expect(result).toEqual({ ok: true, data: { outcome: { status: "sent", messageId: "message-1", externalId: "provider-1" } } })
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.not.objectContaining({ obligationFence: expect.anything() }))
  })

  it("rejects a generic send while any saved obligation is outstanding", async () => {
    mocks.readContext.mockResolvedValue(baseContext("required"))

    const result = await sendRepSms({ propertyId: "property-1", assignmentId: "sender-1", composition })

    expect(result.ok).toBe(false)
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.adminRpc).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ error: expect.objectContaining({ message: expect.stringContaining("saved SMS follow-up") }) }))
  })

  it("rejects a resume request that names a different obligation", async () => {
    mocks.readContext.mockResolvedValue(baseContext("required"))

    const result = await sendRepSms({ propertyId: "property-1", obligationId: "wrong-obligation", assignmentId: "sender-1", composition })

    expect(result.ok).toBe(false)
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(mocks.adminRpc).not.toHaveBeenCalled()
  })

  it("claims the exact saved obligation and uses its claimed recipient", async () => {
    mocks.readContext.mockResolvedValue(baseContext("failed_not_dispatched"))
    mocks.adminRpc.mockResolvedValueOnce({ data: { ok: true, state: "sending", claimToken: "claim-1", claimGeneration: 1, assignmentId: "sender-1", toNumber: "+18165550123" }, error: null })
    mocks.dispatch.mockResolvedValue({ status: "sent", messageId: "message-1", externalId: "provider-1" })

    const result = await sendRepSms({ propertyId: "property-1", obligationId: "obligation-1", assignmentId: "stale-sender", to: "+19995550101", composition })

    expect(result).toEqual({ ok: true, data: { outcome: { status: "sent", messageId: "message-1", externalId: "provider-1" } } })
    expect(mocks.adminRpc).toHaveBeenNthCalledWith(1, "fn_claim_authorize_rep_sms_obligation", expect.objectContaining({
      p_org_id: "org-1", p_obligation_id: "obligation-1", p_actor_id: "rep-1",
    }))
    expect(mocks.dispatch).toHaveBeenCalledWith(expect.objectContaining({ assignmentId: "sender-1", to: "+18165550123", obligationFence: expect.objectContaining({ obligationId: "obligation-1", claimToken: "claim-1", claimGeneration: 1, actorId: "rep-1", propertyId: "property-1", assignmentId: "sender-1", toNumber: "+18165550123", compositionFingerprint: expect.any(String) }) }))
    expect(mocks.adminRpc).toHaveBeenNthCalledWith(2, "fn_record_rep_sms_obligation_result", expect.objectContaining({
      p_obligation_id: "obligation-1", p_claim_token: "claim-1", p_state: "accepted", p_provider_message_id: "provider-1",
    }))
  })

  it.each(["unknown", "delivery_failed", "blocked"])("does not auto-retry a %s obligation", async (status) => {
    mocks.readContext.mockResolvedValue(baseContext(status))

    const result = await sendRepSms({ propertyId: "property-1", obligationId: "obligation-1", assignmentId: "sender-1", composition })

    expect(result.ok).toBe(true)
    expect(mocks.adminRpc).not.toHaveBeenCalled()
    expect(mocks.dispatch).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ data: { outcome: expect.objectContaining({ status: "unknown", reason: expect.stringContaining("Automatic retry is disabled") }) } }))
  })

  it("records a provider failure as unknown instead of retrying generically", async () => {
    mocks.readContext.mockResolvedValue(baseContext("required"))
    mocks.adminRpc.mockResolvedValueOnce({ data: { ok: true, state: "sending", claimToken: "claim-1", claimGeneration: 1, assignmentId: "sender-1", toNumber: "+18165550123" }, error: null })
    mocks.dispatch.mockResolvedValue({ status: "provider_failed", messageId: "message-1", error: "provider rejected" })

    const result = await sendRepSms({ propertyId: "property-1", obligationId: "obligation-1", assignmentId: "sender-1", composition })

    expect(result).toEqual(expect.objectContaining({ data: { outcome: { status: "unknown", reason: "provider rejected" } } }))
    expect(mocks.adminRpc).toHaveBeenNthCalledWith(2, "fn_record_rep_sms_obligation_result", expect.objectContaining({ p_state: "unknown", p_provider_error: "provider rejected" }))
  })

  it("records a provider deferral as unknown because delivery is unresolved", async () => {
    mocks.readContext.mockResolvedValue(baseContext("required"))
    mocks.adminRpc.mockResolvedValueOnce({ data: { ok: true, state: "sending", claimToken: "claim-1", claimGeneration: 1, assignmentId: "sender-1", toNumber: "+18165550123" }, error: null })
    mocks.dispatch.mockResolvedValue({ status: "provider_deferred", messageId: "message-1", error: "provider retry scheduled", attempt: 1, retryAt: new Date().toISOString() })

    const result = await sendRepSms({ propertyId: "property-1", obligationId: "obligation-1", assignmentId: "sender-1", composition })

    expect(result).toEqual(expect.objectContaining({ data: { outcome: { status: "unknown", reason: "provider retry scheduled" } } }))
    expect(mocks.adminRpc).toHaveBeenNthCalledWith(2, "fn_record_rep_sms_obligation_result", expect.objectContaining({ p_state: "unknown", p_provider_error: "provider retry scheduled" }))
  })

  it("keeps a pre-provider authorization fence failure retryable", async () => {
    mocks.readContext.mockResolvedValue(baseContext("required"))
    mocks.adminRpc.mockResolvedValueOnce({ data: { ok: true, state: "sending", claimToken: "claim-1", claimGeneration: 1, assignmentId: "sender-1", toNumber: "+18165550123" }, error: null })
    mocks.dispatch.mockResolvedValue({ status: "provider_failed", messageId: "message-1", error: "stale dispatch fence", providerAttempted: false })

    const result = await sendRepSms({ propertyId: "property-1", obligationId: "obligation-1", assignmentId: "sender-1", composition })

    expect(result).toEqual(expect.objectContaining({ data: { outcome: { status: "failed_not_dispatched", reason: "stale dispatch fence" } } }))
    expect(mocks.adminRpc).toHaveBeenNthCalledWith(2, "fn_record_rep_sms_obligation_result", expect.objectContaining({ p_state: "failed_not_dispatched", p_provider_error: "stale dispatch fence" }))
  })
})
