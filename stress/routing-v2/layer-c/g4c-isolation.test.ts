import { execSync } from "node:child_process";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, it, vi } from "vitest";

import { assertStack, Receipt } from "./lib/env";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { BMH, createRunOrg, retirePriorRuns, seedLeads, type RunOrg } from "./lib/seed";
import { loadReplay, offsetToChicago, ProviderStubs, setClockOffset } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

/** G4c (STRESS §5.4): presence check for the isolation boundary + what exists (outbox provider fence). */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const stubs = new ProviderStubs(loadReplay());
let org: RunOrg;
const R = new Receipt("G4c-isolation.txt");
const pending: Promise<unknown>[] = [];
const ROOT = path.resolve(__dirname, "../../..");

beforeAll(async () => {
  assertStack(); await pg.connect(); stubs.install();
  setClockOffset(offsetToChicago(12, 0)); // business hours on the JS clock (the stack may be at night)
  workflowSink.onStart = (c: WorkflowCall) => { pending.push(c.fn(c.params).catch((e) => ({ error: String(e) }))); };
  org = await createRunOrg(pg, `g4c-${Date.now()}`, { questions_live: true, replies: true, drips: true, canary_percent: 100 });
  await retirePriorRuns(pg);
});
afterAll(async () => { setClockOffset(0); stubs.uninstall(); await pg.end(); });

it("G4c isolation", async () => {
  const grep = (pat: string) => {
    try { return execSync(`grep -rIl -E '${pat}' src supabase stress/routing-v2/fixtures 2>/dev/null || true`, { cwd: ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; }
  };
  const items: Array<[string, string]> = [
    ["assertSendAllowed at the provider adapter (final send boundary)", "assertSendAllowed"],
    ["TEST_DEST_ALLOWLIST (owned numbers via op at run time)", "TEST_DEST_ALLOWLIST"],
    ["test_run_id column / taint on seeded + derived rows", "test_run_id"],
    ["refused_non_owned refusal + log", "refused_non_owned"],
    ["stress/seed.mjs --run <id> seeder", "seed\\.mjs"],
    ["scoped workers (--run <run-id>, claim only that test_run_id)", "[-]-run <run|claim.*test_run_id"],
    ["shadow has no send capability (lint rule / type test)", "no-restricted-imports.*shadow|shadow.*cannot import"],
    ["stress_run_id grep gate", "stress_run_id"],
  ];
  let missing = 0;
  for (const [label, pat] of items) {
    const hits = grep(pat);
    if (!hits.length) missing++;
    R.line(`${hits.length ? "PRESENT" : "MISSING"} ${label} :: grep /${pat}/ -> ${hits.length ? hits.slice(0, 5).join(", ") : "no match"}`);
  }
  R.check("§5.4 isolation boundary built", missing === 0, { missingItems: missing, of: items.length });

  // What exists: the routing v2 outbox provider fence.
  const { createTestClient } = await import("@tests/integration/client");
  const db = createTestClient() as unknown as { rpc: (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }> };
  let fenceProp = "00000000-0000-0000-0000-000000000002", fenceInbound = "00000000-0000-0000-0000-000000000003";
  const fence = async (id: string) => { const r = await db.rpc("routing_v2_check_authorized_outbox_send", { p_outbox_id: id, p_property_id: fenceProp, p_inbound_message_id: fenceInbound }); return r.error ? `error:${(r.error as { message: string }).message}` : r.data; };
  const [lead] = await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }) });
  stubs.jevOverride = () => ({ text_only: 0.95 });
  await deliverWebhook({ externalId: `${org.runId}-fence`, from: lead!.phone, to: org.sender, body: "text me only" });
  while (pending.length) await Promise.all(pending.splice(0));
  stubs.jevOverride = null;
  const row = (await pg.query("select id, status, inbound_message_id from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead!.propertyId])).rows[0];
  const results0: Record<string, unknown> = {};
  if (row) {
    fenceProp = lead!.propertyId; fenceInbound = row.inbound_message_id;
    results0[`own row before claim (${row.status})`] = await fence(row.id);
    // claimed but never authorized
    await pg.query("update public.routing_v2_outbox set status = 'claimed', claimed_at = now() where id = $1 and status = 'pending'", [row.id]);
    results0["claimed, not authorized"] = await fence(row.id);
    fenceInbound = "00000000-0000-0000-0000-000000000003";
    results0["claimed, wrong inbound id"] = await fence(row.id);
    fenceInbound = row.inbound_message_id;
  }
  const results: Record<string, unknown> = { ...results0, randomId: await fence("00000000-0000-0000-0000-000000000001") };
  if (row) {
    results[`own row (${row.status})`] = await fence(row.id);
    await pg.query("update public.routing_v2_outbox set status = 'cancelled', cancel_reason = 'stress_fence_probe' where id = $1 and status <> 'sent'", [row.id]);
    results["after cancel"] = await fence(row.id);
  }
  R.check("outbox provider fence refuses unknown / cancelled / non-authorized rows", Object.entries(results).every(([k, v]) => k.startsWith("own row (sent") || v !== "ok"), results);

  // Negative: a run-tagged lead pointing at an arbitrary (non-owned) number is still texted —
  // nothing at the send boundary knows the row is test data.
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const [lead2] = await seedLeads(pg, org, 1, { state: () => ({ state: "MO", fips: null }) });
  stubs.jevOverride = () => ({ text_only: 0.95 });
  await deliverWebhook({ externalId: `${org.runId}-nonowned`, from: lead2!.phone, to: org.sender, body: "text me only" });
  while (pending.length) await Promise.all(pending.splice(0));
  stubs.jevOverride = null;
  await runRoutingV2OutboxReplies(createTestClient(), { limit: 20 });
  for (let i = 0; i < 50; i++) { // let the detached post-transition kick finish
    const st = (await pg.query("select status from routing_v2_outbox where property_id = $1 and kind = 'reply'", [lead2!.propertyId])).rows[0]?.status;
    if (st === "sent" || st === "cancelled") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const sentToSeeded = getMockMessageLog().filter((m) => m.to === lead2!.phone).length;
  R.check("test-tagged lead to a non-owned number is refused at the send boundary", sentToSeeded === 0, { mockSendsToSeededNumber: sentToSeeded, number: lead2!.phone, note: "seeded number is arbitrary/non-owned; the mock provider accepted the send" });
  void BMH;
});
