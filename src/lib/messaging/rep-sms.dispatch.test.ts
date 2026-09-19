import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adminRpc: vi.fn(),
  createClient: vi.fn(),
  provider: vi.fn(),
  sendSmsToContact: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.adminRpc }) }));
vi.mock("./providers/sendillo", () => ({ sendilloFromEnvWithOptions: mocks.provider }));
vi.mock("./send", () => ({ sendSmsToContact: mocks.sendSmsToContact }));

import { dispatchRepSms, readRepSmsContext } from "./rep-sms";

const composition = {
  introId: "mel-maria-assistant-1",
  introVersion: 2,
  templateId: "no-answer-callback-time",
  templateVersion: 1,
  initialRemainder: "Maria wasn't able to reach you. What time would work for her to call you back?",
  remainder: "Please text Maria a time that works.",
};

const contextData = {
  orgId: "org-1",
  actorId: "rep-1",
  contactId: "contact-1",
  provider: "sendillo",
  senders: [{
    id: "sender-1",
    number: "+18163706846",
    label: "Mel",
    isDefault: true,
    provider: "sendillo",
    providerAccountId: "account-1",
    providerSenderId: "provider-sender-1",
    grantStatus: "active",
    compositionPolicyVersion: 1,
  }],
  obligation: null,
};

function setupClient() {
  const client = {
    rpc: vi.fn((name: string) => Promise.resolve(
      name === "fn_get_rep_sms_context"
        ? { data: contextData, error: null }
        : { data: { draft: null }, error: null },
    )),
    from: vi.fn(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({
            data: {
              phone_1: "+18165550123",
              phone_1_type: "mobile",
              phone_2: null,
              phone_2_type: null,
              phone_3: null,
              phone_3_type: null,
            },
            error: null,
          }),
        }),
      }),
    })),
  };
  mocks.createClient.mockResolvedValue(client);
  return client;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
  vi.stubEnv("SENDILLO_ORG_ID", "org-1");
  setupClient();
  mocks.provider.mockReturnValue({ providerId: "sendillo" });
  mocks.sendSmsToContact.mockResolvedValue({
    status: "sent",
    messageId: "message-1",
    externalId: "provider-1",
  });
});

describe("dispatchRepSms durable generic reservation", () => {
  it("recovers the server draft after storage loss and replays it under a fresh browser key", async () => {
    const originalKey = "11111111-1111-4111-8111-111111111111";
    const freshKey = "22222222-2222-4222-8222-222222222222";
    const recoveredDraft = {
      key: originalKey,
      receiptId: "receipt-1",
      state: "delivered",
      assignmentId: "sender-1",
      from: "+18163706846",
      to: "+18165550123",
      body: "Hey, this is Mel with BMH, Maria's assistant.\n\nPlease text Maria a time that works.",
      composition,
      providerMessageId: "provider-1",
      providerError: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const client = setupClient();
    let draftReads = 0;
    client.rpc.mockImplementation(((name: string) => Promise.resolve(
      name === "fn_get_rep_sms_context"
        ? { data: contextData, error: null }
        : { data: { draft: ++draftReads === 1 ? null : recoveredDraft }, error: null },
    )) as never);
    mocks.adminRpc
      .mockResolvedValueOnce({
        data: {
          ok: true,
          receiptId: "receipt-1",
          claimToken: "claim-1",
          claimGeneration: 1,
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { ok: true, state: "accepted", providerMessageId: "provider-1" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: { ok: true, state: "delivered", providerMessageId: "provider-1" },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          ok: false,
          receiptId: "receipt-1",
          state: "delivered",
          messageId: "message-1",
          providerMessageId: "provider-1",
          claimGeneration: 1,
        },
        error: null,
      });
    mocks.sendSmsToContact.mockImplementation(async (_client, sendInput) => {
      await mocks.adminRpc("fn_record_rep_sms_delivery_result", {
        p_receipt_id: sendInput.repSmsReceipt.receiptId,
        p_claim_token: sendInput.repSmsReceipt.claimToken,
        p_claim_generation: sendInput.repSmsReceipt.claimGeneration,
        p_state: "accepted",
        p_provider_message_id: "provider-1",
      });
      // The callback wins before the original action response reaches the
      // browser. This must leave the recovery row open for reload.
      await mocks.adminRpc("fn_record_rep_sms_delivery_ledger_callback", {
        p_provider: "sendillo",
        p_provider_account_id: "account-1",
        p_provider_message_id: "provider-1",
        p_state: "delivered",
      });
      return { status: "sent", messageId: "message-1", externalId: "provider-1" };
    });

    const input = {
      propertyId: "property-1",
      assignmentId: "sender-1",
      idempotencyKey: originalKey,
      to: "+18165550123",
      composition,
    };

    const first = await dispatchRepSms(input);
    // Simulate a reload after the action response and browser storage both
    // disappeared. The server ledger is the only remaining draft source.
    const reloaded = await readRepSmsContext("property-1");
    const second = await dispatchRepSms({ ...input, idempotencyKey: freshKey });

    expect(first).toEqual({ status: "sent", messageId: "message-1", externalId: "provider-1" });
    expect(reloaded.submission).toEqual(expect.objectContaining({
      key: originalKey,
      receiptId: "receipt-1",
      state: "delivered",
      from: recoveredDraft.from,
      to: recoveredDraft.to,
      body: recoveredDraft.body,
    }));
    expect(second).toEqual({ status: "sent", messageId: "message-1", externalId: "provider-1" });
    expect(mocks.sendSmsToContact).toHaveBeenCalledTimes(1);
    expect(mocks.adminRpc).toHaveBeenNthCalledWith(1, "fn_claim_rep_sms_delivery_with_composition", expect.objectContaining({
      p_submission_key: input.idempotencyKey,
      p_property_id: input.propertyId,
      p_contact_id: "contact-1",
      p_body: "Hey, this is Mel with BMH, Maria's assistant.\n\nPlease text Maria a time that works.",
      p_composition: expect.objectContaining({ remainder: composition.remainder }),
    }));
    expect(mocks.adminRpc).toHaveBeenNthCalledWith(2, "fn_record_rep_sms_delivery_result", expect.objectContaining({
      p_receipt_id: "receipt-1",
      p_state: "accepted",
    }));
    expect(mocks.adminRpc).toHaveBeenNthCalledWith(3, "fn_record_rep_sms_delivery_ledger_callback", expect.objectContaining({
      p_provider_message_id: "provider-1",
      p_state: "delivered",
    }));
    expect(mocks.adminRpc).toHaveBeenNthCalledWith(4, "fn_claim_rep_sms_delivery_with_composition", expect.objectContaining({
      p_submission_key: freshKey,
    }));
    expect(mocks.adminRpc).toHaveBeenCalledTimes(4);
  });

  it("rejects a cross-organization context before claiming a delivery or calling the provider", async () => {
    const client = setupClient();
    client.rpc.mockImplementation(((name: string) => Promise.resolve(
      name === "fn_get_rep_sms_context"
        ? {
            data: { ...contextData, orgId: "org-2" },
            error: null,
          }
        : { data: { draft: null }, error: null },
    )) as never);

    await expect(dispatchRepSms({
      propertyId: "property-2",
      assignmentId: "sender-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      composition,
    })).rejects.toThrow("Sendillo texting is not available for this organization.");
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.sendSmsToContact).not.toHaveBeenCalled();
  });

  it("fails closed before a provider dispatch when the Sendillo organization scope is missing", async () => {
    vi.stubEnv("SENDILLO_ORG_ID", "");

    await expect(dispatchRepSms({
      propertyId: "property-1",
      assignmentId: "sender-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      composition,
    })).rejects.toThrow("Sendillo texting organization scope is not configured.");
    expect(mocks.adminRpc).not.toHaveBeenCalled();
    expect(mocks.sendSmsToContact).not.toHaveBeenCalled();
  });
});
