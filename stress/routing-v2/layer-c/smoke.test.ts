import { Client } from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { assertStack, finishNoLiveClassifier } from "./lib/env";
import { deliverWebhook, workflowSink, type WorkflowCall } from "./lib/driver";
import { retirePriorRuns, createRunOrg, seedLeads, type RunOrg } from "./lib/seed";
import { loadReplay, ProviderStubs } from "./lib/stubs";

vi.mock("workflow/api", async (o) => (await import("./lib/wf-mock")).workflowMocks.api(o as never));
vi.mock("workflow", async (o) => (await import("./lib/wf-mock")).workflowMocks.core(o as never));

const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const stubs = new ProviderStubs(loadReplay());
let org: RunOrg;

beforeAll(async () => { assertStack(); await pg.connect(); stubs.install(); });
afterAll(async () => { finishNoLiveClassifier(); stubs.uninstall(); await pg.end(); });

it("smoke: webhook -> workflow -> v2 decision -> outbox -> mock send", async () => {
  const { runRoutingV2OutboxReplies } = await import("@/lib/ai-responder/dispatch");
  const { getMockMessageLog } = await import("@/lib/messaging/providers/mock");
  const { createTestClient } = await import("@tests/integration/client");
  org = await createRunOrg(pg, `smoke-${Date.now()}`, { questions_live: true, replies: true, drips: true, haiku: true, price_check: true, canary_percent: 100 });
  await retirePriorRuns(pg);
  const leads = await seedLeads(pg, org, 4);
  const calls: WorkflowCall[] = [];
  workflowSink.onStart = (c) => calls.push(c);
  const texts = ["It's going to have to be via text. I'm blind in one ear and can't see or of the other.", "Not interested", "Who is this?", "How does it work?"];
  stubs.jevOverride = (r) => r === "Not interested" ? { not_interested: 0.95 } : r === "Who is this?" ? { asked_who: 0.95 } : r === "How does it work?" ? { how_it_works: 0.95 } : null;
  for (let i = 0; i < 4; i++) expect(await deliverWebhook({ externalId: `smoke-${org.runId}-${i}`, from: leads[i]!.phone, to: org.sender, body: texts[i]! })).toBe(200);
  console.log("workflow starts", calls.length);
  for (const c of calls) console.log(JSON.stringify(await c.fn(c.params)));
  const db = createTestClient();
  console.log(JSON.stringify(await runRoutingV2OutboxReplies(db, { limit: 20 })));
  const { rows } = await pg.query("select d.road, d.status, o.kind, o.status ostatus, o.cancel_reason from routing_v2_live_decisions d left join routing_v2_outbox o on o.inbound_message_id = d.inbound_message_id where d.org_id = $1", [org.orgId]);
  console.log(rows);
  const { rows: en } = await pg.query("select s.name, e.status from sequence_enrollments e join sequences s on s.id = e.sequence_id where e.org_id = $1", [org.orgId]);
  console.log(en);
  console.log(getMockMessageLog().map((m) => [m.to, m.body.slice(0, 50)]));
  console.log(stubs.calls.map((c) => [c.provider, c.status, c.key.slice(0, 20)]));
});
