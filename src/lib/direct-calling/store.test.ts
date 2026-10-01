// The real Supabase-backed store against a stubbed admin client: pins the exact RPC names and payloads the
// store sends, so the TypeScript side can never drift from the SQL functions' parameter contract
// (the migration integration test feeds the SAME serializer's output into the real SQL).
import { describe, expect, it } from "vitest";

import { createSupabaseDirectCallStore } from "./store";
import { cleanupSpecToJson } from "./serialize";
import { makeRow } from "./test-support";
import type { CleanupSpec } from "./transitions";

type Call = { fn: string; args: Record<string, unknown> };

function stub(responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const row = makeRow();
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "neq", "is", "not", "limit"]) chain[name] = () => chain;
  chain.single = async () => ({ data: row, error: null });
  chain.maybeSingle = async () => ({ data: row, error: null });
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
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
      direct_call_cleanup_claim: [],
      direct_call_resume_claim: [],
    });
    await store.beginCall({ org_id: "o", operator_user_id: "u", property_id: "p", contact_id: "k", destination_e164: "+1555", caller_id_e164: "+1666", client_request_id: "r" });
    await store.cancelRequest("u", "o", "r");
    await store.setTarget("c1", { property_id: "p", contact_id: "k", destination_e164: "+1555" });
    await store.discardReservation("c1");
    await store.dialSucceeded("c1", "leg", "seller");
    await store.dialRejected("c1", "browser");
    await store.addLegCleanup("c1", "leg");
    await store.claimDueCleanups("u", "2026-10-01T12:00:00.000Z", 45, 1);
    await store.claimPendingResumes("u", "2026-10-01T12:00:00.000Z", 30);
    await store.clearResumePending("c1");
    await store.operatorBusy("u");
    await store.findActiveForUser("u");
    expect(calls).toEqual([
      { fn: "direct_call_begin", args: { p_org: "o", p_operator: "u", p_property: "p", p_contact: "k", p_destination: "+1555", p_caller: "+1666", p_request: "r" } },
      { fn: "direct_call_cancel_request", args: { p_org: "o", p_operator: "u", p_request: "r" } },
      { fn: "direct_call_set_target", args: { p_id: "c1", p_property: "p", p_contact: "k", p_destination: "+1555" } },
      { fn: "direct_call_discard_reservation", args: { p_id: "c1" } },
      { fn: "direct_call_dial_succeeded", args: { p_id: "c1", p_leg: "leg", p_role: "seller" } },
      { fn: "direct_call_dial_rejected", args: { p_id: "c1", p_role: "browser" } },
      { fn: "direct_call_cleanup_add_leg", args: { p_id: "c1", p_leg: "leg" } },
      { fn: "direct_call_cleanup_claim", args: { p_user: "u", p_now: "2026-10-01T12:00:00.000Z", p_lease_secs: 45, p_limit: 1 } },
      { fn: "direct_call_resume_claim", args: { p_user: "u", p_now: "2026-10-01T12:00:00.000Z", p_lease_secs: 30 } },
      { fn: "direct_call_resume_done", args: { p_id: "c1" } },
      { fn: "direct_call_operator_busy", args: { p_user: "u" } },
      { fn: "direct_call_active_for_operator", args: { p_user: "u" } },
    ]);
  });
});
