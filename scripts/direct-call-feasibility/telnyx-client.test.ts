/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it, vi } from "vitest";
import { TelnyxClient, GuardError, TelnyxError } from "./telnyx-client";
import { Budget, BudgetError } from "./budget";
import { cfg, inventory, jsonRes, PHONE, SECRET } from "./test-helpers";

function make(over: { dryRun?: boolean; budget?: Budget; fetchImpl?: any } = {}) {
  const fetchImpl = over.fetchImpl ?? vi.fn(async () => jsonRes({ data: { call_control_id: "newleg", call_session_id: "s" } }));
  const lines: string[] = [];
  const config = cfg();
  const client = new TelnyxClient({ config, inventory: inventory(), dryRun: over.dryRun ?? false, budget: over.budget, fetchImpl, log: (l) => lines.push(l) });
  return { client, fetchImpl, lines, config };
}

describe("guard", () => {
  it("refuses update/delete/call-control on non-inventory IDs before any network call", async () => {
    const { client, fetchImpl } = make();
    await expect(client.request("DELETE", "/credential_connections/other")).rejects.toThrow(GuardError);
    await expect(client.request("PATCH", "/outbound_voice_profiles/other", {})).rejects.toThrow(GuardError);
    await expect(client.request("POST", "/calls/otherleg/actions/hangup", {})).rejects.toThrow(GuardError);
    await expect(client.request("DELETE", "/phone_numbers/anything")).rejects.toThrow(GuardError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("allows reads, and mutation of inventoried IDs", async () => {
    const { client, fetchImpl } = make();
    await client.request("GET", "/phone_numbers");
    await client.request("DELETE", "/credential_connections/conn1");
    await client.request("POST", "/calls/leg1/actions/hangup", {});
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("dial target allowlist and limits", () => {
  it("allows owned phone, test credential SIP username and dev SIP endpoint", async () => {
    const { client } = make();
    await client.dial({ to: PHONE });
    await client.dial({ to: "sip:gencreduser1@sip.telnyx.com" });
    await client.dial({ to: "sip:dev@example.test" });
  });

  it("refuses any other target without a network call", async () => {
    const { client, fetchImpl } = make();
    for (const to of ["+15555559999", "sip:someoneelse@sip.telnyx.com", "sip:gencreduser1@evil.example", "gencreduser2"]) {
      await expect(client.dial({ to })).rejects.toThrow(GuardError);
    }
    await expect(client.request("POST", "/calls/leg1/actions/transfer", { to: "+15555559999" })).rejects.toThrow(GuardError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("every Dial carries time_limit_secs and ring timeout_secs; bodies without them are refused", async () => {
    const { client, fetchImpl } = make();
    await client.dial({ to: PHONE });
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sent.time_limit_secs).toBe(180);
    expect(sent.timeout_secs).toBe(30);
    expect(sent.command_id).toMatch(/^[0-9a-f-]{36}$/);
    const base = { connection_id: "app1", to: PHONE, from: "+15555550199" };
    await expect(client.request("POST", "/calls", base)).rejects.toThrow(GuardError);
    await expect(client.request("POST", "/calls", { ...base, time_limit_secs: 180 })).rejects.toThrow(GuardError);
    await expect(client.request("POST", "/calls", { ...base, time_limit_secs: 3600, timeout_secs: 30 })).rejects.toThrow(GuardError);
    await expect(client.request("POST", "/calls", { ...base, time_limit_secs: 180, timeout_secs: 90 })).rejects.toThrow(GuardError);
  });

  it("never re-sends the same operation", async () => {
    const { client, fetchImpl } = make();
    await client.dial({ to: PHONE, opId: "op-1" });
    await expect(client.dial({ to: PHONE, opId: "op-1" })).rejects.toThrow(GuardError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("inventories the leg it created", async () => {
    const { client } = make();
    await client.dial({ to: PHONE });
    await expect(client.request("POST", "/calls/newleg/actions/hangup", {})).resolves.toBeDefined();
  });
});

describe("redaction", () => {
  it("never logs Authorization or the key, in logs or errors", async () => {
    const fetchImpl = vi.fn(async () => jsonRes(`bad Bearer ${SECRET} for ${PHONE} key=${SECRET}`, 401));
    const { client, lines } = make({ fetchImpl });
    let err: unknown;
    try { await client.request("GET", "/phone_numbers"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(TelnyxError);
    const all = lines.join("\n") + (err as Error).message;
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(PHONE);
    expect(all.toLowerCase()).not.toContain("authorization");
  });

  it("redacts network error messages", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`boom ${SECRET}`); });
    const { client } = make({ fetchImpl });
    await expect(client.request("GET", "/x")).rejects.toThrow(/\[REDACTED\]/);
  });
});

describe("budget", () => {
  it("stops at 60 attempts", () => {
    const b = new Budget(cfg({ DIRECT_CALL_EST_COST_PER_LEG_MIN_USD: "0.001" }).limits);
    for (let i = 0; i < 60; i++) b.reserveAttempt();
    expect(() => b.reserveAttempt()).toThrow(BudgetError);
    expect(b.attempts).toBe(60);
  });

  it("stops at $25 estimated spend", () => {
    // $3 per minute * 3 min = $9 per attempt: 2 attempts = $18, third would be $27 > $25
    const b = new Budget(cfg({ DIRECT_CALL_EST_COST_PER_LEG_MIN_USD: "3" }).limits);
    b.reserveAttempt();
    b.reserveAttempt();
    expect(() => b.reserveAttempt()).toThrow(/\$25/);
    expect(b.attempts).toBe(2);
  });

  it("is enforced by Dial and a refused Dial sends nothing", async () => {
    const budget = new Budget(cfg({ DIRECT_CALL_MAX_ATTEMPTS: "1" }).limits);
    const { client, fetchImpl } = make({ budget });
    await client.dial({ to: PHONE });
    await expect(client.dial({ to: PHONE })).rejects.toThrow(BudgetError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("env can tighten but not loosen the approved envelope", () => {
    expect(() => cfg({ DIRECT_CALL_MAX_ATTEMPTS: "61" })).toThrow();
    expect(() => cfg({ DIRECT_CALL_MAX_SPEND_USD: "26" })).toThrow();
  });
});

describe("dry run", () => {
  it("makes no fetch calls at all, even for reads and dials", async () => {
    const { client, fetchImpl } = make({ dryRun: true });
    await client.request("GET", "/phone_numbers");
    await client.dial({ to: PHONE });
    await client.request("DELETE", "/credential_connections/conn1");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(client.dryRunRequests.length).toBe(3);
  });
});
