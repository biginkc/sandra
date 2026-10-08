import { describe, expect, it, vi } from "vitest";

import type { BlandClient, BlandSendResult } from "./bland";
import type { NormaBlandConfig } from "./config";
import { dispatchNormaCall } from "./dispatch";
import type { NormaQueueConfig } from "./queue/config";
import { fakeClient, PHONE, REQUEST_ID, requestRow } from "./test-helpers";

// RED: runtime integration of the queue SQL contract (docs/norma/queue-sql-contract.md s.4) into dispatchNormaCall, on top of #793.
//  H1: claim_dispatch_v2 replaces fn_norma_claim_dispatch; fn_norma_mark_sending replaces presendNormaFence (right before sendCall).
//  H2: queue rows skip the precall SMS (build default); button attempt-1 rows keep today's behaviour.
// PROPOSED shapes (names, not business rules): deps.queueConfig (NormaQueueConfig) and deps.now (ms) feed claim_v2's p_* arguments;
// mark_sending answers `sending` | `refused:<reason>`; new DispatchResult status `busy` for capacity_* / number_busy.
// Reason strings after `refused:` are the contract vocabulary (s.4 fn_norma_mark_sending): lease_mismatch | token_rotated | stale_claim | not_dispatching | lease_expired | window_closed | queue_disabled | control_off | blocked | ineligible:<reason>
// (consent reasons voice_consent_opted_out / sms_consent_opted_out are PROPOSED in the contract).
// NOTE: dispatch.test.ts still stubs the legacy claim/fence; those assertions are replaced when this lands.

vi.mock("@/lib/errors/report", () => ({ reportError: vi.fn() }));

const blandConfig: NormaBlandConfig = {
  apiKey: "k", baseUrl: "https://bland.test", pathwayId: "pw", pathwayVersion: 17, voice: "voice-1",
  fromNumber: "+12135550100", webhookUrl: "https://sandra.test/h", timeoutMs: 1000, waitForGreeting: true, backgroundTrack: "office",
};
const openGate = { dispatchEnabled: true, sellerRelease: false, allowedNumbers: [PHONE] };
const NOW = Date.parse("2030-01-09T16:00:00Z");
const queueConfig: NormaQueueConfig = { enabled: true, maxConcurrent: 5, dailyCap: 200, capTz: "America/Chicago", problems: [] };
const QUEUE_ROW = { queue_entry_id: "entry-1", queue_dispatch_token: "disp-tok", queue_lease_token: "lease-tok" };

function setup(opts: {
  row?: Record<string, unknown>;
  claim?: string;
  markSending?: string | (() => never);
  eligible?: boolean;
  precallSms?: import("./precall-sms").PrecallDeps;
  config?: NormaQueueConfig;
  send?: BlandSendResult;
} = {}) {
  const order: string[] = [];
  const sendCall = vi.fn(async () => (order.push("send"), opts.send ?? { kind: "accepted" as const, callId: "call-1" }));
  const bland: BlandClient = { sendCall: sendCall as never, getCall: vi.fn() };
  const rpcs = {
    fn_norma_claim_dispatch_v2: vi.fn(() => (order.push("claim_v2"), opts.claim ?? "claimed")),
    fn_norma_mark_sending: vi.fn(() => {
      order.push("mark_sending");
      if (typeof opts.markSending === "function") return opts.markSending();
      return opts.markSending ?? "sending";
    }),
    fn_norma_eligibility: vi.fn(() => (order.push("eligibility"), [opts.eligible === false ? { eligible: false, block_reason: "dnc_locked" } : { eligible: true }])),
    fn_norma_bind_call_id: vi.fn().mockReturnValue("bound"),
    fn_norma_mark_dispatch_rejected: vi.fn().mockReturnValue("dispatch_rejected"),
    fn_norma_mark_dispatch_unknown: vi.fn().mockReturnValue("dispatch_unknown"),
  };
  const { client, calls } = fakeClient(
    {
      norma_call_requests: [requestRow(opts.row)],
      properties: [{ id: "p1", org_id: "org1", address: "1 Main", city: "KC", state: "MO", zip: "64111" }],
      lead_notes: [],
      contacts: [{ id: "c1", first_name: "Sam" }],
    },
    rpcs,
  );
  const run = () =>
    dispatchNormaCall(REQUEST_ID, {
      client, bland, blandConfig, gate: openGate, precallSms: opts.precallSms,
      queueConfig: opts.config ?? queueConfig, now: () => NOW,
    } as never);
  return { run, sendCall, rpcs, calls, order };
}

const names = (t: ReturnType<typeof setup>) => t.calls.map((c) => c.name);

describe("dispatchNormaCall — admission through claim_dispatch_v2 and mark_sending (H1)", () => {
  it("button request: claim_v2 -> eligibility -> mark_sending -> send, with the contract's arguments", async () => {
    const t = setup();
    await expect(t.run()).resolves.toEqual({ status: "dispatched", callId: "call-1" });
    expect(t.order).toEqual(["claim_v2", "eligibility", "mark_sending", "send"]);
    expect(t.rpcs.fn_norma_claim_dispatch_v2).toHaveBeenCalledWith({
      p_request_id: REQUEST_ID, p_expected_attempt: 1, p_now: new Date(NOW).toISOString(),
      p_queue_enabled: true, p_max_concurrent: 5, p_daily_cap: 200, p_cap_tz: "America/Chicago",
    });
    expect(t.rpcs.fn_norma_mark_sending).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_expected_attempt: 1 });
  });

  it("never calls the legacy claim or the presend fence any more", async () => {
    const t = setup();
    await t.run();
    expect(names(t)).not.toContain("fn_norma_claim_dispatch");
    expect(names(t)).not.toContain("fn_norma_presend_fence");
  });

  it("queue request: mark_sending carries the request's dispatch token", async () => {
    const t = setup({ row: QUEUE_ROW });
    await expect(t.run()).resolves.toEqual({ status: "dispatched", callId: "call-1" });
    expect(t.rpcs.fn_norma_mark_sending).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_dispatch_token: "disp-tok", p_expected_attempt: 1 });
  });

  it("a button request does not pass a dispatch token", async () => {
    const t = setup();
    await t.run();
    expect((t.rpcs.fn_norma_mark_sending.mock.calls as unknown[][])[0][0]).not.toHaveProperty("p_dispatch_token");
  });

  it("the queue switch being off is passed to the database as p_queue_enabled=false (the button still has an admission path)", async () => {
    const t = setup({ config: { ...queueConfig, enabled: false } });
    await t.run();
    expect(t.rpcs.fn_norma_claim_dispatch_v2).toHaveBeenCalledWith(expect.objectContaining({ p_queue_enabled: false }));
  });

  it("an attempt-2 row is admitted with its own attempt on both calls", async () => {
    const t = setup({ row: { attempt: 2 } });
    await t.run();
    expect(t.rpcs.fn_norma_claim_dispatch_v2).toHaveBeenCalledWith(expect.objectContaining({ p_expected_attempt: 2 }));
    expect(t.rpcs.fn_norma_mark_sending).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_expected_attempt: 2 });
  });
});

describe("dispatchNormaCall — claim_dispatch_v2 refusals (nothing is sent, nothing is marked sending)", () => {
  it.each([
    ["capacity_concurrency", { status: "busy", reason: "capacity_concurrency" }],
    ["capacity_daily", { status: "busy", reason: "capacity_daily" }],
    ["number_busy", { status: "busy", reason: "number_busy" }],
    ["not_claimed", { status: "not_claimed" }],
    ["queue_refused:window_closed", { status: "rejected", reason: "queue_refused:window_closed" }],
    ["queue_refused:lease_expired", { status: "rejected", reason: "queue_refused:lease_expired" }],
  ])("%s -> %j", async (claim, expected) => {
    for (const row of [undefined, QUEUE_ROW]) {
      const t = setup({ claim, row });
      await expect(t.run()).resolves.toEqual(expected);
      expect(t.sendCall).not.toHaveBeenCalled();
      expect(t.rpcs.fn_norma_mark_sending).not.toHaveBeenCalled();
    }
  });

  it.each(["capacity_concurrency", "capacity_daily", "number_busy"])(
    "%s on a button request closes it as dispatch_rejected with the busy reason before returning busy (no later dial)",
    async (claim) => {
      const t = setup({ claim });
      await expect(t.run()).resolves.toEqual({ status: "busy", reason: claim });
      expect(t.rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalledWith({ p_request_id: REQUEST_ID, p_reason: claim, p_expected_status: "requested", p_expected_attempt: 1 });
    },
  );

  it("busy on a button request that another worker already claimed: not_claimed, not busy", async () => {
    const t = setup({ claim: "capacity_daily" });
    t.rpcs.fn_norma_mark_dispatch_rejected.mockReturnValue("dispatching");
    await expect(t.run()).resolves.toEqual({ status: "not_claimed" });
  });

  it("busy on a queue row leaves the request open (the queue tick owns it); busy on a call-twice retry keeps waiting", async () => {
    for (const row of [QUEUE_ROW, { attempt: 2 }]) {
      const t = setup({ claim: "capacity_concurrency", row });
      await expect(t.run()).resolves.toEqual({ status: "busy", reason: "capacity_concurrency" });
      expect(t.rpcs.fn_norma_mark_dispatch_rejected).not.toHaveBeenCalled();
    }
  });

  it("ineligible:<reason> on a button request closes the request as dispatch_rejected with that reason", async () => {
    const t = setup({ claim: "ineligible:dnc_locked" });
    await expect(t.run()).resolves.toEqual({ status: "rejected", reason: "ineligible:dnc_locked" });
    expect(t.rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalledWith(expect.objectContaining({ p_request_id: REQUEST_ID, p_reason: "ineligible:dnc_locked" }));
    expect(t.sendCall).not.toHaveBeenCalled();
  });
});

describe("dispatchNormaCall — mark_sending refusals", () => {
  describe("queue rows: SQL already closed the request as dispatch_rejected; the runtime reports the reason and never sends", () => {
    it.each(["window_closed", "lease_expired", "lease_mismatch", "token_rotated", "queue_disabled", "control_off", "blocked", "ineligible:dnc_locked", "ineligible:voice_consent_opted_out", "ineligible:sms_consent_opted_out"])("refused:%s", async (reason) => {
      const t = setup({ row: QUEUE_ROW, markSending: `refused:${reason}` });
      await expect(t.run()).resolves.toEqual({ status: "rejected", reason });
      expect(t.sendCall).not.toHaveBeenCalled();
      expect(t.rpcs.fn_norma_mark_dispatch_rejected).not.toHaveBeenCalled();
    });
  });

  describe("button rows: fence-type refusals (stale / wrong status) keep the #793 not_claimed behaviour", () => {
    it.each(["stale_claim", "not_dispatching"])("refused:%s -> not_claimed, row left for reconcile", async (reason) => {
      const t = setup({ markSending: `refused:${reason}` });
      await expect(t.run()).resolves.toEqual({ status: "not_claimed" });
      expect(t.sendCall).not.toHaveBeenCalled();
      expect(t.rpcs.fn_norma_mark_dispatch_rejected).not.toHaveBeenCalled();
    });
  });

  describe("button rows: eligibility / consent refusals close the request as dispatch_rejected ineligible:<reason>", () => {
    it.each(["dnc_locked", "voice_consent_opted_out", "sms_consent_opted_out"])("refused:ineligible:%s", async (reason) => {
      const t = setup({ markSending: `refused:ineligible:${reason}` });
      await expect(t.run()).resolves.toEqual({ status: "rejected", reason: `ineligible:${reason}` });
      expect(t.sendCall).not.toHaveBeenCalled();
      expect(t.rpcs.fn_norma_mark_dispatch_rejected).toHaveBeenCalledWith(expect.objectContaining({ p_request_id: REQUEST_ID, p_reason: `ineligible:${reason}` }));
    });
  });

  it("a mark_sending transport error fails closed as not_claimed: nothing is sent", async () => {
    const t = setup({ markSending: () => { throw new Error("rpc down"); } });
    await expect(t.run()).resolves.toEqual({ status: "not_claimed" });
    expect(t.sendCall).not.toHaveBeenCalled();
  });
});

describe("dispatchNormaCall — precall SMS (H2)", () => {
  const sms = (): import("./precall-sms").PrecallDeps => ({
    enabled: true,
    send: vi.fn(async () => ({ status: "sent", messageId: "m", externalId: "e" }) as never),
  });

  it("queue requests skip the precall SMS even when the feature is on, and eligibility is read once", async () => {
    const precallSms = sms();
    const t = setup({ row: QUEUE_ROW, precallSms });
    await expect(t.run()).resolves.toEqual({ status: "dispatched", callId: "call-1" });
    expect(precallSms.send).not.toHaveBeenCalled();
    expect(t.rpcs.fn_norma_eligibility).toHaveBeenCalledTimes(1);
    expect(t.order).toEqual(["claim_v2", "eligibility", "mark_sending", "send"]);
  });

  it("button attempt-1 requests keep today's behaviour: text, recheck eligibility, THEN mark_sending, then send", async () => {
    const precallSms = sms();
    const t = setup({ precallSms });
    await expect(t.run()).resolves.toEqual({ status: "dispatched", callId: "call-1" });
    expect(precallSms.send).toHaveBeenCalledTimes(1);
    expect(t.order).toEqual(["claim_v2", "eligibility", "eligibility", "mark_sending", "send"]);
  });

  it("button attempt-2 requests still never text", async () => {
    const precallSms = sms();
    const t = setup({ precallSms, row: { attempt: 2 } });
    await t.run();
    expect(precallSms.send).not.toHaveBeenCalled();
  });

});
