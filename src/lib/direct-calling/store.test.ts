// The real Supabase-backed store against a stubbed admin client: pins the exact RPC names and payloads the
// store sends, so the TypeScript side can never drift from the SQL functions' parameter contract
// (the migration integration test feeds the SAME serializer's output into the real SQL).
import { describe, expect, it } from "vitest";

import { createSupabaseDirectCallStore } from "./store";
import { cleanupSpecToJson } from "./serialize";
import { FakeStore, makeRow } from "./test-support";
import type { CleanupSpec } from "./transitions";

type Call = { fn: string; args: Record<string, unknown> };
type RpcError = { code: string; message: string };

function stub(responses: Record<string, unknown> = {}, errors: Record<string, RpcError> = {}) {
  const calls: Call[] = [];
  const row = makeRow();
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "neq", "is", "not", "or", "limit"]) chain[name] = () => chain;
  chain.single = async () => ({ data: row, error: null });
  chain.maybeSingle = async () => ({ data: row, error: null });
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      if (fn in errors) return { data: null, error: errors[fn] };
      return { data: fn in responses ? responses[fn] : null, error: null };
    },
    from: () => chain,
  };
  return { store: createSupabaseDirectCallStore(admin as never), calls };
}

describe("createSupabaseDirectCallStore RPC payloads", () => {
  it("serialises every cleanup spec kind with all the fields direct_call_apply reads (#743-1)", async () => {
    const { store, calls } = stub({ direct_call_apply: [makeRow()] });
    const specs: CleanupSpec[] = [
      { kind: "leg", legId: "leg-1" },
      { kind: "unresolved_dial", role: "seller", timeoutSecs: 30, timeLimitSecs: 7195 },
      { kind: "unresolved_dial", role: "browser", timeoutSecs: 30, timeLimitSecs: 7200 },
    ];
    await store.updateIfStatus("call-1", ["browser_connecting", "seller_dialing"], { status: "seller_dialing", browser_leg_id: "b-1", seller_dial_state: "pending", failure_reason: null }, specs);
    expect(calls).toEqual([
      {
        fn: "direct_call_apply",
        args: {
          p_id: "call-1",
          p_statuses: ["browser_connecting", "seller_dialing"],
          p_patch: { status: "seller_dialing", browser_leg_id: "b-1", seller_dial_state: "pending", failure_reason: null },
          p_cleanups: [
            { kind: "leg", leg_id: "leg-1" },
            { kind: "unresolved_dial", role: "seller", timeout_secs: 30, time_limit_secs: 7195 },
            { kind: "unresolved_dial", role: "browser", timeout_secs: 30, time_limit_secs: 7200 },
          ],
        },
      },
    ]);
    expect(specs.map(cleanupSpecToJson)).toEqual(calls[0].args.p_cleanups);
  });

  it("sends no cleanups as an empty array", async () => {
    const { store, calls } = stub({ direct_call_apply: [makeRow()] });
    await store.updateIfStatus("call-1", ["connected"], { status: "ending" });
    expect(calls[0].args).toEqual({ p_id: "call-1", p_statuses: ["connected"], p_patch: { status: "ending" }, p_cleanups: [] });
  });

  it("uses the SQL parameter names for every other store write", async () => {
    const { store, calls } = stub({
      direct_call_begin: [{ outcome: "created", call_id: "c1" }],
      direct_call_cancel_request: [{ outcome: "tombstoned", call_id: "c1" }],
      direct_call_dial_succeeded: true,
      direct_call_dial_started: true,
      direct_call_set_target: true,
      direct_call_cleanup_claim: [],
      direct_call_resume_claim: [],
    });
    await store.beginCall({ org_id: "o", operator_user_id: "u", property_id: "p", preparation_property_id: null, contact_id: "k", destination_e164: "+1555", caller_id_e164: "+1666", time_limit_secs: 180, client_request_id: "r", browser_watchdog_session_id: "watchdog-session" });
    await store.cancelRequest("u", "o", "r");
    expect(await store.setTarget("c1", { property_id: "p", contact_id: "k", destination_e164: "+1555" })).toBe(true);
    await store.discardReservation("c1");
    await store.dialSucceeded("c1", "leg", "seller");
    await store.markDialStarted("c1", "seller", "2026-10-01T12:00:00.000Z", 30, 180);
    await store.dialRejected("c1", "browser");
    await store.addLegCleanup("c1", "leg");
    await store.claimDueCleanups("u", "2026-10-01T12:00:00.000Z", 45, 1);
    await store.claimPendingResumes("u", "2026-10-01T12:00:00.000Z", 30);
    await store.clearResumePending("c1");
    await store.operatorBusy("u");
    await store.findActiveForUser("u");
    expect(calls).toEqual([
      { fn: "direct_call_begin", args: { p_org: "o", p_operator: "u", p_property: "p", p_preparation_property: null, p_contact: "k", p_destination: "+1555", p_caller: "+1666", p_request: "r", p_time_limit_secs: 180, p_watchdog_session: "watchdog-session" } },
      { fn: "direct_call_cancel_request", args: { p_org: "o", p_operator: "u", p_request: "r" } },
      { fn: "direct_call_set_target", args: { p_id: "c1", p_property: "p", p_contact: "k", p_destination: "+1555" } },
      { fn: "direct_call_discard_reservation", args: { p_id: "c1" } },
      { fn: "direct_call_dial_succeeded", args: { p_id: "c1", p_leg: "leg", p_role: "seller" } },
      { fn: "direct_call_dial_started", args: { p_id: "c1", p_role: "seller", p_started_at: "2026-10-01T12:00:00.000Z", p_timeout_secs: 30, p_time_limit_secs: 180 } },
      { fn: "direct_call_dial_rejected", args: { p_id: "c1", p_role: "browser" } },
      { fn: "direct_call_cleanup_add_leg", args: { p_id: "c1", p_leg: "leg" } },
      { fn: "direct_call_cleanup_claim", args: { p_user: "u", p_now: "2026-10-01T12:00:00.000Z", p_lease_secs: 45, p_limit: 1 } },
      { fn: "direct_call_resume_claim", args: { p_user: "u", p_now: "2026-10-01T12:00:00.000Z", p_lease_secs: 30 } },
      { fn: "direct_call_resume_done", args: { p_id: "c1" } },
      { fn: "direct_call_operator_busy", args: { p_user: "u" } },
      { fn: "direct_call_active_for_operator", args: { p_user: "u" } },
    ]);
  });

  it("the in-memory store rejects a dispatch marker after teardown has begun", async () => {
    const store = new FakeStore();
    const row = makeRow({ failure_reason: "teardown_pending" });
    store.add(row);
    store.addCleanup({ direct_call_id: row.id, kind: "unresolved_dial", dial_role: "browser" });
    expect(await store.markDialStarted(row.id, "browser", "2026-10-01T12:00:00.000Z", 30, 7200)).toBe(false);
    expect(store.openFor(row.id)).toHaveLength(1);
    expect(store.openFor(row.id)[0].dial_started_at).toBeNull();
  });

  it("maps only definite begin validation failures to an unreserved refusal", async () => {
    const call = { org_id: "o", operator_user_id: "u", property_id: null, preparation_property_id: "p", contact_id: null, destination_e164: "", caller_id_e164: "+1666", time_limit_secs: 180, client_request_id: "r" };
    for (const code of ["22P02", "23503"]) {
      const { store } = stub({}, { direct_call_begin: { code, message: "invalid preparation target" } });
      await expect(store.beginCall(call)).resolves.toEqual({ outcome: "invalid_target" });
    }

    const { store } = stub({}, { direct_call_begin: { code: "08006", message: "connection lost" } });
    await expect(store.beginCall(call)).rejects.toThrow("connection lost");
  });
});
