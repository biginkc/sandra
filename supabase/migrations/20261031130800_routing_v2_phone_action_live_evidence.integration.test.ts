import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * 20261031130800: PR-G's phone action re-derives its decision from the LIVE decision log.
 * Shadow rows never authorize it. Fixture mirrors the 250000 suite (one rolled-back tx each).
 */
const db = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL!) });
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const read = (...p: string[]) => strip(readFileSync(path.join(__dirname, ...p), "utf8"));
const M = read("20261031130800_routing_v2_phone_action_live_evidence.sql");
const X = "+18165550101";
let orgId: string, p1: string, p2: string, c1: string, inbound: string;

beforeAll(() => db.connect());
afterAll(() => db.end());
beforeEach(async () => {
  await db.query("begin");
  await db.query(read("20261030250000_routing_v2_wrong_number_all.sql"));
  await db.query(M);
  [orgId, p1, p2, c1, inbound] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  await db.query("insert into public.organizations (id, name) values ($1, 'prg live')", [orgId]);
  await db.query("set local session_replication_role = replica");
  await db.query("insert into public.ai_responder_configs (org_id, system_prompt, active, routing_v2_flags) values ($1, 'x', true, $2)",
    [orgId, JSON.stringify({ questions_live: true, wrong_number_all: true, canary_percent: 100 })]);
  await db.query("insert into public.contacts (id, org_id, phone_1) values ($1, $2, $3)", [c1, orgId, X]);
  for (const p of [p1, p2]) {
    await db.query("insert into public.properties (id, org_id, address, state, status, homeowner_contact_id) values ($1, $2, 'St', 'MO', 'prospect', $3)", [p, orgId, c1]);
  }
  await db.query("insert into public.messages (id, org_id, property_id, channel, direction, body, from_address, created_at) values ($1, $2, $3, 'sms', 'inbound', 'nobody by that name', $4, now() - interval '1 minute')",
    [inbound, orgId, p1, X]);
  await db.query("set local session_replication_role = origin");
});
afterEach(() => db.query("rollback"));

const WRONG = { by: "jev", row: "3", step: "wrong", signal: "wrong_person", probability: 0.9 };
async function live(over: Record<string, unknown> = {}) {
  await db.query(
    "insert into public.routing_v2_live_decisions (org_id, property_id, inbound_message_id, status, road, jev_road, provenance, haiku_eligibility, haiku, expected_revision) values ($1,$2,$3,'decided',$4,$5,$6,$7,$8,0)",
    [orgId, p1, inbound, over.road ?? "wrong_number_close", over.jev_road ?? "wrong_number_close", JSON.stringify(over.provenance ?? WRONG),
      over.haiku_eligibility ?? null, over.haiku === undefined ? null : JSON.stringify(over.haiku)],
  );
}
async function shadow() {
  await db.query("insert into public.routing_v2_shadow_decisions (org_id, property_id, inbound_message_id, status, road, provenance) values ($1,$2,$3,'decided','wrong_number_close',$4)",
    [orgId, p1, inbound, JSON.stringify(WRONG)]);
}
async function applyAll(action = "wrong_number_all") {
  await db.query("savepoint svc");
  await db.query("set local role service_role");
  await db.query("select set_config('request.jwt.claim.role', 'service_role', true)");
  const rev = (await db.query("select decision_context_revision r from public.properties where id = $1", [p1])).rows[0].r;
  const r = (await db.query("select public.fn_routing_v2_phone_action_apply_all($1, $2, $3, $4::jsonb, $5) as r", [inbound, action, X, JSON.stringify({ wrong_scope: "all" }), rev])).rows[0].r;
  await db.query("reset role");
  await db.query("release savepoint svc");
  return r;
}

describe("PR-G phone action reads live evidence", () => {
  it("a live Jev wrong-person decision closes every property on the phone", async () => {
    await live();
    const r = await applyAll();
    expect(r.status).toBe("applied");
    expect([...r.applied].sort()).toEqual([p1, p2].sort());
  });
  it("a shadow row alone never authorizes a live phone action", async () => {
    await shadow();
    expect(await applyAll()).toMatchObject({ status: "not_applicable", reason: "no_decision_record" });
  });
  it("uses Jev's original road, not the post-Haiku action road", async () => {
    await live({ road: "haiku_unsure", jev_road: "wrong_number_close", haiku_eligibility: "decider_band", haiku: { hold: true, final_road: null } });
    expect(await applyAll()).toMatchObject({ status: "not_applicable", reason: "haiku_not_confirmed" });
  });
  it("a live bounce decision drives bad_number", async () => {
    await db.query("set local session_replication_role = replica");
    await db.query("update public.messages set body = 'This number has no SMS capabilities' where id = $1", [inbound]);
    await db.query("set local session_replication_role = origin");
    await live({ road: "bad_number", jev_road: "bad_number", provenance: { by: "code", check: "bad_number" } });
    expect((await applyAll("bad_number")).status).toBe("applied");
  });
  it("rollback restores the 250000 body (shadow source) byte for byte", async () => {
    await db.query(read("..", "rollbacks", "20261031130800_routing_v2_phone_action_live_evidence.sql"));
    const src = (await db.query("select prosrc from pg_proc where proname = 'fn_routing_v2_phone_action_apply_all'")).rows[0].prosrc as string;
    expect(readFileSync(path.join(__dirname, "20261030250000_routing_v2_wrong_number_all.sql"), "utf8")).toContain(src);
    expect(src).toContain("routing_v2_shadow_decisions");
  });
});
