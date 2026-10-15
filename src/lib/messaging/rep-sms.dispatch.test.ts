import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  adminRpc: vi.fn(),
  stampRow: vi.fn(),
  bindRpc: vi.fn(),
  readRpc: vi.fn(),
  createClient: vi.fn(),
  provider: vi.fn(),
  sendSmsToContact: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({
    rpc: (name: string, args: Record<string, unknown>) =>
      name === "fn_bind_rep_sms_inbound_stamp"
        ? mocks.bindRpc(args)
        : name === "fn_get_rep_sms_inbound_stamp"
          ? mocks.readRpc(args)
          : mocks.adminRpc(name, args),
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => mocks.stampRow() }) }) }),
  }),
}));
vi.mock("./providers/sendillo", () => ({ sendilloFromEnvWithOptions: mocks.provider }));
vi.mock("./send", () => ({ sendSmsToContact: mocks.sendSmsToContact }));

import { dispatchRepSms, readRepSmsContext, createRepSmsObligationFence } from "./rep-sms";
import { composeRepSms } from "./rep-sms-composition";

const composition = {
  acquisitionsManager: "Maria",
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
  mocks.bindRpc.mockImplementation(async (args: { p_inbound_message_id: string | null }) => ({ data: args.p_inbound_message_id, error: null }));
  mocks.readRpc.mockResolvedValue({ data: null, error: null });
  mocks.provider.mockReturnValue({ providerId: "sendillo" });
  mocks.sendSmsToContact.mockResolvedValue({
    status: "sent",
    messageId: "message-1",
    externalId: "provider-1",
  });
});

describe("dispatchRepSms durable generic reservation", () => {
  it("sends the selected manager's introduction and records that manager in metadata", async () => {
    mocks.adminRpc
      .mockResolvedValueOnce({ data: { ok: true, receiptId: "receipt-1", claimToken: "claim-1", claimGeneration: 1 }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, state: "accepted", providerMessageId: "provider-1" }, error: null });
    await dispatchRepSms({
      propertyId: "property-1",
      assignmentId: "sender-1",
      idempotencyKey: "11111111-1111-4111-8111-111111111111",
      composition: { ...composition, acquisitionsManager: "Jordan", remainder: "Please text Jordan a time that works." },
    });
    const send = mocks.sendSmsToContact.mock.calls[0][1];
    expect(send.body).toBe("Hey, this is Mel with BMH, Jordan's assistant.\n\nPlease text Jordan a time that works.");
    expect(send.metadata.repSms).toMatchObject({ workflow: "manager-through-mel", assistant: "Jordan", acquisitionsManager: "Jordan" });
  });
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
    expect(mocks.adminRpc.mock.calls[0][1].p_composition).not.toHaveProperty("acquisitionsManager");
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

describe("dispatchRepSms inbound reply stamp", () => {
  const INBOUND = "33333333-3333-4333-8333-333333333333";
  const key = "11111111-1111-4111-8111-111111111111";
  const claim = () => mocks.adminRpc
    .mockResolvedValueOnce({ data: { ok: true, receiptId: "receipt-1", claimToken: "claim-1", claimGeneration: 1 }, error: null })
    .mockResolvedValueOnce({ data: { ok: true, state: "accepted", providerMessageId: "provider-1" }, error: null });
  const base = { propertyId: "property-1", assignmentId: "sender-1", idempotencyKey: key, composition };

  it("stamps a valid inbound id as top-level metadata.inbound_message_id", async () => {
    claim();
    mocks.stampRow.mockResolvedValue({
      data: { direction: "inbound", org_id: "org-1", property_id: "property-1", conversation_id: null },
      error: null,
    });
    await dispatchRepSms({ ...base, inboundMessageId: INBOUND });
    const send = mocks.sendSmsToContact.mock.calls[0][1];
    expect(send.metadata.inbound_message_id).toBe(INBOUND);
    expect(send.metadata.repSms).toBeDefined();
  });

  it("drops the stamp for a cross-property inbound id and still sends", async () => {
    claim();
    mocks.stampRow.mockResolvedValue({
      data: { direction: "inbound", org_id: "org-1", property_id: "other-property", conversation_id: null },
      error: null,
    });
    const outcome = await dispatchRepSms({ ...base, inboundMessageId: INBOUND });
    expect(outcome.status).toBe("sent");
    expect(mocks.sendSmsToContact.mock.calls[0][1].metadata).not.toHaveProperty("inbound_message_id");
  });

  it("drops the stamp for an outbound message or another org", async () => {
    for (const row of [
      { direction: "outbound", org_id: "org-1", property_id: "property-1", conversation_id: null },
      { direction: "inbound", org_id: "org-2", property_id: "property-1", conversation_id: null },
    ]) {
      mocks.sendSmsToContact.mockClear();
      mocks.adminRpc.mockReset();
      claim();
      mocks.stampRow.mockResolvedValue({ data: row, error: null });
      await dispatchRepSms({ ...base, inboundMessageId: INBOUND });
      expect(mocks.sendSmsToContact.mock.calls[0][1].metadata).not.toHaveProperty("inbound_message_id");
    }
  });

  it("without an id the metadata has only repSms and no stamp bind or lookup happens", async () => {
    claim();
    await dispatchRepSms(base);
    const metadata = mocks.sendSmsToContact.mock.calls[0][1].metadata;
    expect(Object.keys(metadata)).toEqual(["repSms"]);
    expect(mocks.stampRow).not.toHaveBeenCalled();
    // Complete sequence: the persisted-stamp read only. No bind with a null id.
    expect(mocks.readRpc).toHaveBeenCalledTimes(1);
    expect(mocks.bindRpc).not.toHaveBeenCalled();
    expect(mocks.adminRpc.mock.calls.map((c) => c[0])).toEqual(["fn_claim_rep_sms_delivery_with_composition"]);
  });
});

describe("dispatchRepSms stamp binding to the durable record", () => {
  const ORIGINAL = "33333333-3333-4333-8333-333333333333";
  const NEWER = "44444444-4444-4444-8444-444444444444";
  const valid = () => mocks.stampRow.mockResolvedValue({
    data: { direction: "inbound", org_id: "org-1", property_id: "property-1", conversation_id: null },
    error: null,
  });
  const base = { propertyId: "property-1", assignmentId: "sender-1", composition };

  it("binds a generic send to its ledger receipt and a retry reuses the ORIGINAL stamp", async () => {
    valid();
    mocks.adminRpc
      .mockResolvedValueOnce({ data: { ok: true, receiptId: "receipt-1", claimToken: "c", claimGeneration: 1 }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, state: "accepted" }, error: null });
    // The ledger already holds ORIGINAL; the browser now (after reload) supplies NEWER.
    mocks.readRpc.mockResolvedValue({ data: ORIGINAL, error: null });
    await dispatchRepSms({ ...base, idempotencyKey: "11111111-1111-4111-8111-111111111111", inboundMessageId: NEWER });
    expect(mocks.readRpc).toHaveBeenCalledWith({ p_kind: "draft", p_id: "receipt-1", p_org_id: "org-1" });
    expect(mocks.sendSmsToContact.mock.calls[0][1].metadata.inbound_message_id).toBe(ORIGINAL);
  });

  it("recovers the stored stamp even when the browser supplies none", async () => {
    valid();
    mocks.adminRpc
      .mockResolvedValueOnce({ data: { ok: true, receiptId: "receipt-1", claimToken: "c", claimGeneration: 1 }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, state: "accepted" }, error: null });
    mocks.readRpc.mockResolvedValue({ data: ORIGINAL, error: null });
    await dispatchRepSms({ ...base, idempotencyKey: "11111111-1111-4111-8111-111111111111" });
    expect(mocks.readRpc).toHaveBeenCalledWith(expect.objectContaining({ p_kind: "draft" }));
    expect(mocks.sendSmsToContact.mock.calls[0][1].metadata.inbound_message_id).toBe(ORIGINAL);
  });

  const resumeWithObligation = async (supplied: string) => {
    valid();
    const client = setupClient();
    const obligation = {
      id: "obligation-1", attemptId: "attempt-1", status: "claimed", messageBody: "x", composition,
      blockedReason: null, senderAssignmentId: "sender-1", fromNumber: "+18163706846", toNumber: "+18165550123",
    };
    client.rpc.mockImplementation(((name: string) => Promise.resolve(
      name === "fn_get_rep_sms_context"
        ? { data: { ...contextData, obligation }, error: null }
        : { data: { draft: null }, error: null },
    )) as never);
    const composed = composeRepSms(composition);
    return dispatchRepSms({
      ...base,
      to: "+18165550123",
      inboundMessageId: supplied,
      obligationFence: createRepSmsObligationFence({
        obligationId: "obligation-1", claimToken: "t", claimGeneration: 2, actorId: "rep-1",
        propertyId: "property-1", assignmentId: "sender-1", toNumber: "+18165550123", composition: composed,
      }),
    });
  };

  it("binds an obligation resume to the obligation id and stamps the stored ORIGINAL", async () => {
    mocks.readRpc.mockResolvedValue({ data: ORIGINAL, error: null });
    const outcome = await resumeWithObligation(NEWER);
    expect(outcome.status).toBe("sent");
    expect(mocks.readRpc).toHaveBeenCalledWith({ p_kind: "obligation", p_id: "obligation-1", p_org_id: "org-1" });
    expect(mocks.sendSmsToContact.mock.calls[0][1].metadata.inbound_message_id).toBe(ORIGINAL);
  });

  it("stored X, browser Y, bind RPC fails -> stamped X", async () => {
    mocks.readRpc.mockResolvedValue({ data: ORIGINAL, error: null });
    mocks.bindRpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const outcome = await resumeWithObligation(NEWER);
    expect(outcome.status).toBe("sent");
    expect(mocks.sendSmsToContact.mock.calls[0][1].metadata.inbound_message_id).toBe(ORIGINAL);
  });

  it("read fails but bind returns the stored original -> stamped X", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.readRpc.mockResolvedValue({ data: null, error: { message: "timeout" } });
    mocks.bindRpc.mockResolvedValue({ data: ORIGINAL, error: null });
    await resumeWithObligation(NEWER);
    expect(mocks.sendSmsToContact.mock.calls[0][1].metadata.inbound_message_id).toBe(ORIGINAL);
  });

  it("nothing stored and the bind fails -> unstamped, never the browser id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.readRpc.mockResolvedValue({ data: null, error: null });
    mocks.bindRpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const outcome = await resumeWithObligation(NEWER);
    expect(outcome.status).toBe("sent");
    expect(mocks.bindRpc).toHaveBeenCalledTimes(2); // one retry
    const metadata = mocks.sendSmsToContact.mock.calls[0][1].metadata;
    expect(metadata).not.toHaveProperty("inbound_message_id");
    expect(metadata.inbound_stamp_unresolved).toBe(true);
  });

  it("stored value unreadable AND bind fails -> marker, no inbound_message_id, send not blocked", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.readRpc.mockResolvedValue({ data: null, error: { message: "timeout" } });
    mocks.bindRpc.mockResolvedValue({ data: null, error: { message: "timeout" } });
    const outcome = await resumeWithObligation(NEWER);
    expect(outcome.status).toBe("sent");
    const metadata = mocks.sendSmsToContact.mock.calls[0][1].metadata;
    expect(metadata).not.toHaveProperty("inbound_message_id");
    expect(metadata.inbound_stamp_unresolved).toBe(true);
  });

  it("nothing captured and the store is unreadable -> marker", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.readRpc.mockResolvedValue({ data: null, error: { message: "timeout" } });
    mocks.adminRpc
      .mockResolvedValueOnce({ data: { ok: true, receiptId: "receipt-1", claimToken: "c", claimGeneration: 1 }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, state: "accepted" }, error: null });
    await dispatchRepSms({ ...base, idempotencyKey: "11111111-1111-4111-8111-111111111111" });
    expect(mocks.sendSmsToContact.mock.calls[0][1].metadata.inbound_stamp_unresolved).toBe(true);
  });

  it("nothing stored and the bind succeeds -> the browser id is stamped", async () => {
    await resumeWithObligation(NEWER);
    const metadata = mocks.sendSmsToContact.mock.calls[0][1].metadata;
    expect(metadata.inbound_message_id).toBe(NEWER);
    expect(metadata).not.toHaveProperty("inbound_stamp_unresolved");
  });
});

describe("dispatchRepSms replacing a failed send", () => {
  const withLeadObligation = (status: string) => {
    const client = setupClient();
    const obligation = {
      id: "obligation-9", attemptId: "attempt-9", status, messageBody: "x", composition,
      blockedReason: null, senderAssignmentId: "sender-1", fromNumber: "+18163706846", toNumber: "+18165550123",
    };
    client.rpc.mockImplementation(((name: string) => Promise.resolve(
      name === "fn_get_rep_sms_context"
        ? { data: { ...contextData, obligation }, error: null }
        : { data: { draft: null }, error: null },
    )) as never);
  };
  const send = (extra: Record<string, unknown>) => dispatchRepSms({
    propertyId: "property-1", assignmentId: "sender-1", idempotencyKey: "33333333-3333-4333-8333-333333333333", composition, ...extra,
  } as never);

  it("a terminal-failed lead obligation (delivery_failed) does not block a verified replacement", async () => {
    mocks.adminRpc
      .mockResolvedValueOnce({ data: { ok: true, receiptId: "r", claimToken: "c", claimGeneration: 1 }, error: null })
      .mockResolvedValueOnce({ data: { ok: true, state: "accepted" }, error: null });
    withLeadObligation("delivery_failed");
    await expect(send({ replacingFailedSend: true })).resolves.toMatchObject({ status: "sent" });
  });

  it("without the server-set flag, or with a live obligation (required), the saved follow-up still blocks a generic send", async () => {
    withLeadObligation("delivery_failed");
    await expect(send({})).rejects.toThrow(/saved SMS follow-up/);
    withLeadObligation("required");
    await expect(send({ replacingFailedSend: true })).rejects.toThrow(/saved SMS follow-up/);
    expect(mocks.sendSmsToContact).not.toHaveBeenCalled();
  });
});

describe("dispatchRepSms fenced resume adopts the fenced obligation", () => {
  const base = { propertyId: "property-1", assignmentId: "sender-1", composition };
  const fenceFor = (id: string) => createRepSmsObligationFence({
    obligationId: id, claimToken: "t", claimGeneration: 2, actorId: "rep-1",
    propertyId: "property-1", assignmentId: "sender-1", toNumber: "+18165550123", composition: composeRepSms(composition),
  });
  const oblRow = (id: string, state: string) => ({
    id, attempt_id: "att", state, message_body: "x", composition, blocked_reason: null, sender_assignment_id: "sender-1",
    from_number: "+18163706846", to_number: "+18165550123",
  });
  function clientWith(newest: Record<string, unknown>, rows: Record<string, unknown>) {
    const client = {
      rpc: vi.fn((name: string) => Promise.resolve(name === "fn_get_rep_sms_context" ? { data: { ...contextData, obligation: newest }, error: null } : { data: { draft: null }, error: null })),
      from: vi.fn((table: string) => {
        const filters: Record<string, string> = {}
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = (c: string, v: string) => ((filters[c] = v), chain)
        chain.maybeSingle = () => Promise.resolve({ data: table === "rep_sms_obligations" ? rows[filters.id] ?? null : { phone_1: "+18165550123", phone_1_type: "mobile" }, error: null })
        return chain
      }),
    }
    mocks.createClient.mockResolvedValue(client)
  }
  const newest = { id: "obl-B", attemptId: "b", status: "required", messageBody: "x", composition, blockedReason: null, senderAssignmentId: "sender-1", fromNumber: "+18163706846", toNumber: "+18165550123" }

  it("an older fenced obligation already in 'sending' proceeds although a newer open one exists", async () => {
    clientWith(newest, { "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": oblRow("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "sending") })
    const outcome = await dispatchRepSms({ ...base, to: "+18165550123", obligationFence: fenceFor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") })
    expect(outcome.status).toBe("sent")
  })

  it("a fence for a row this actor does not own still throws", async () => {
    clientWith(newest, {})
    await expect(dispatchRepSms({ ...base, to: "+18165550123", obligationFence: fenceFor("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") })).rejects.toThrow(/follow-up changed/)
    expect(mocks.sendSmsToContact).not.toHaveBeenCalled()
  })
})
