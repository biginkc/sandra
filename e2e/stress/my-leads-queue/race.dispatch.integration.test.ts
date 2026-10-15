import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { createClient as createSupabase } from "@supabase/supabase-js";
import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";

import { assertEnvLooksLocal, resolveDbUrl } from "./guards";
import { HARNESS_ADDRESS_PREFIX } from "./guards";
import { materializeWorld, setupOrg, type OrgCtx } from "./materialize";
import { HOUR, emptyLead, SEC } from "./model";
import { preflightCommitLanes } from "./races";
import type { LaneResult } from "./report";
import { createRng } from "../prng";

/**
 * Race lanes that drive the REAL `dispatchRepSms` (stamp resolution, ledger claim, stamp binding) against the disposable database.
 *
 * Faked, and only these: the server Supabase client (a PostgREST client signed in as the rep with a locally minted JWT, so the
 * app's RPCs run as the rep exactly like a server action), the Sendillo provider (an in-process object that is never asked to send) and
 * `sendSmsToContact` (replaced by a fake that writes the same `pending` -> `sent` message rows with the metadata dispatchRepSms built, after
 * a fake provider latency). No provider is called and no message leaves the machine.
 *
 * Needs the PostgREST API of the disposable stack (LOCAL_SUPABASE_URL, default http://127.0.0.1:54331) and
 * MYLEADS_STRESS_DISPOSABLE_DB=1. Reps: MYLEADS_STRESS_DISPATCH_REPS (default 6; the manual volume run uses 200).
 * Writes `dispatch-lanes.json` to MYLEADS_STRESS_OUT_DIR (default test-results/my-leads-queue-stress) for the main report.
 */
const state = vi.hoisted(() => ({
  client: null as unknown,
  send: null as null | ((client: unknown, input: Record<string, unknown>) => Promise<unknown>),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => state.client }));
vi.mock("@/lib/messaging/providers/sendillo", () => ({ sendilloFromEnvWithOptions: () => ({ providerId: "sendillo" }) }));
vi.mock("@/lib/messaging/send", () => ({ sendSmsToContact: (client: unknown, input: Record<string, unknown>) => state.send!(client, input) }));

import { dispatchRepSms } from "@/lib/messaging/rep-sms";

const env = { ...process.env, MYLEADS_STRESS_DB_URL: process.env.MYLEADS_STRESS_DB_URL ?? process.env.TEST_SUPABASE_DB_URL };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REPS = Number(process.env.MYLEADS_STRESS_DISPATCH_REPS ?? 6);
const OUT = process.env.MYLEADS_STRESS_OUT_DIR ?? path.resolve("test-results/my-leads-queue-stress");
const JWT_SECRET = process.env.LOCAL_SUPABASE_JWT_SECRET ?? "super-secret-jwt-token-with-at-least-32-characters-long";
const API = process.env.LOCAL_SUPABASE_URL ?? "http://127.0.0.1:54331";
const ANON = process.env.LOCAL_SUPABASE_ANON_KEY ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

function isLoopbackHttp(raw: string): boolean {
  try { const u = new URL(raw); return (u.protocol === "http:" || u.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname); } catch { return false; }
}

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function jwtFor(sub: string): string {
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ sub, role: "authenticated", aud: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${head}.${body}.${createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`;
}

const composition = {
  acquisitionsManager: "Maria", introId: "mel-maria-assistant-1", introVersion: 2, templateId: "no-answer-callback-time", templateVersion: 1,
  initialRemainder: "Maria wasn't able to reach you. What time would work for her to call you back?", remainder: "Please text Maria a time that works.",
};

async function replica(url: string) {
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("set session_replication_role = replica");
  return c;
}

async function committedLead(admin: Client, n: number) {
  const now = Date.now();
  await admin.query("begin");
  try {
    const ctx = await setupOrg(admin);
    const lead = emptyLead(`d${n}`, now, { messages: [{ ref: "x", dir: "inbound", at: now - HOUR, body: "call me" }] });
    const mat = await materializeWorld(admin, ctx, { now, leads: [lead] });
    const property = mat.ids.get(lead.key)!;
    await admin.query("update public.properties set address = $2 || address where id=$1", [property, HARNESS_ADDRESS_PREFIX]);
    await admin.query("insert into public.rep_sms_rollout_enrollments(org_id,user_id,enabled,enrolled_at,enrolled_by) values ($1,$2,true,now(),$3)", [ctx.org, ctx.rep, ctx.owner]);
    const sender = randomUUID();
    await admin.query(
      `insert into public.rep_sms_sender_assignments(id,org_id,user_id,provider,phone_e164,label,is_default,updated_by,provider_account_id,provider_sender_id)
       values ($1,$2,$3,'sendillo','+18165550100','Mel',true,$4,'acct-1','sender-1')`, [sender, ctx.org, ctx.rep, ctx.owner]);
    await admin.query("commit");
    const contact = (await admin.query("select homeowner_contact_id as c from public.properties where id=$1", [property])).rows[0].c as string;
    return { ctx, property, contact, sender, x: mat.messageIds.get(lead.key)!.get("x")! };
  } catch (error) {
    await admin.query("rollback").catch(() => {});
    throw error;
  }
}

function useFakeProvider(url: string, ctx: OrgCtx, latencyMs: number, rep: string) {
  state.client = createSupabase(API, ANON, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${jwtFor(rep)}` } } });
  process.env.MESSAGING_PROVIDER = "sendillo";
  process.env.SENDILLO_ORG_ID = ctx.org;
  state.send = async (_client, input) => {
    const db = await replica(url);
    try {
      const id = randomUUID();
      await db.query(
        `insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata)
         values ($1,$2,'sms','outbound',$3,'pending',$4,$5,clock_timestamp(),$6)`,
        [id, ctx.org, input.body, input.propertyId, input.contactId, JSON.stringify(input.metadata ?? {})]);
      await sleep(latencyMs); // the fake provider takes this long to accept
      await db.query("update public.messages set status='sent', sent_at=clock_timestamp() where id=$1", [id]);
      return { status: "sent", messageId: id, externalId: `fake-${id}` };
    } finally {
      await db.end();
    }
  };
}

const lanes: LaneResult[] = [];

describe("dispatchRepSms race lanes (fake provider, disposable database)", async () => {
  assertEnvLooksLocal(env);
  const url = resolveDbUrl(env);
  for (const [name, value] of [["LOCAL_SUPABASE_URL", API], ["TEST_SUPABASE_URL", process.env.TEST_SUPABASE_URL ?? API]] as const) {
    if (!isLoopbackHttp(value)) throw new Error(`${name} must be a loopback http(s) URL; refusing ${value}`);
  }
  const skip = await preflightCommitLanes(url).catch((error: Error) => error.message);
  // Acknowledged disposable database but the lanes cannot run: that is a failure, not a green skip.
  if (skip && process.env.MYLEADS_STRESS_DISPOSABLE_DB === "1") throw new Error(`dispatchRepSms race lanes cannot run: ${skip}`);
  const run = skip ? it.skip : it;
  if (skip) console.warn(`dispatchRepSms race lanes skipped: ${skip}`);

  run("concurrent inbound Y 50-500 ms after a stamped dispatchRepSms for X begins: Y stays unhandled", async () => {
    const lane: LaneResult = { id: "race:dispatch_stamped_send_vs_inbound", title: "dispatchRepSms stamped for X vs inbound Y 50-500 ms later (fake provider)", runs: 0, failures: 0, samples: [], notes: ["driver dispatchRepSms"] };
    const rng = createRng(11);
    let yBefore = 0, yAfter = 0;
    const admin = new Client({ connectionString: url });
    await admin.connect();
    try {
      for (let n = 0; n < REPS; n += 1) {
        const w = await committedLead(admin, n);
        const latency = rng.int(100, 900), yDelay = rng.int(50, 500);
        useFakeProvider(url, w.ctx, latency, w.ctx.rep);
        const a = await replica(url);
        let y = "";
        try {
          const send = dispatchRepSms({ propertyId: w.property, assignmentId: w.sender, idempotencyKey: randomUUID(), composition, inboundMessageId: w.x });
          const reply = (async () => {
            await sleep(yDelay);
            y = randomUUID();
            await a.query("insert into public.messages(id,org_id,channel,direction,body,status,property_id,contact_id,created_at,metadata) values ($1,$2,'sms','inbound','Actually, make it Friday','received',$3,$4,clock_timestamp(),'{}')", [y, w.ctx.org, w.property, w.contact]);
          })();
          const [outcome] = await Promise.all([send, reply]);
          if ((outcome as { status?: string }).status !== "sent") throw new Error(`dispatchRepSms did not send: ${JSON.stringify(outcome)}`);
        } finally {
          await a.end();
        }
        const row = (await admin.query("select * from public.my_leads_work_classified($1,$2,$3)", [w.ctx.org, w.ctx.rep, new Date(Date.now() + 5 * SEC).toISOString()])).rows.find((r) => r.property_id === w.property);
        const out = (await admin.query("select metadata, sent_at, (select created_at from public.messages where id=$2) as y_at from public.messages where property_id=$1 and direction='outbound'", [w.property, y])).rows;
        const meta = out[0]?.metadata;
        lane.runs += 1;
        // ordering from what the database recorded, like the SQL twin
        if (out.length !== 1 || !out[0].sent_at) { lane.failures += 1; lane.samples.push({ rep: n, why: `expected one accepted outbound, found ${out.length} (sent_at ${out[0]?.sent_at ?? "null"})` }); continue; }
        if (out[0].y_at < out[0].sent_at) yBefore += 1; else yAfter += 1;
        const latest = row.facts.latestInbound;
        if (!(row.row_no === "5" && latest?.messageId === y && latest?.handled === false && meta?.inbound_message_id === w.x)) {
          lane.failures += 1;
          lane.samples.push({ rep: n, latency, yDelay, row: row.row_no, latestInbound: latest, outboundMetadata: meta });
        }
      }
    } finally {
      await admin.end();
    }
    lane.notes!.push(`by database timestamps, Y was created before the text's sent_at in ${yBefore} runs and after it in ${yAfter}`);
    // The stamp only matters when Y lands before the send time (same minimum as the SQL twin).
    if (REPS >= 10 && yBefore < Math.ceil(REPS / 4)) { lane.failures += 1; lane.samples.push({ why: `only ${yBefore} of ${REPS} runs had Y before sent_at` }); }
    lanes.push(lane);
    expect(lane.failures).toBe(0);
  }, 600_000);

  run("bind RPC unavailable: dispatchRepSms still sends, marks the text unresolved, and it handles nothing", async () => {
    const lane: LaneResult = { id: "race:dispatch_bind_failure", title: "stamp bind RPC unavailable during dispatchRepSms (fake provider): unresolved marker, handles nothing", runs: 0, failures: 0, samples: [], notes: ["driver dispatchRepSms", "the function is renamed away and restored in a finally"] };
    const admin = new Client({ connectionString: url });
    await admin.connect();
    const FN = "public.fn_bind_rep_sms_inbound_stamp(text,uuid,uuid,uuid)";
    // self-heal a previous interrupted run
    const leftover = await admin.query("select to_regprocedure('public.fn_bind_rep_sms_inbound_stamp_s1_off(text,uuid,uuid,uuid)') as f");
    if (leftover.rows[0].f) await admin.query("alter function public.fn_bind_rep_sms_inbound_stamp_s1_off(text,uuid,uuid,uuid) rename to fn_bind_rep_sms_inbound_stamp");
    try {
      for (let n = 0; n < Math.min(REPS, 20); n += 1) {
        const w = await committedLead(admin, 1000 + n);
        useFakeProvider(url, w.ctx, 50, w.ctx.rep);
        await admin.query(`alter function ${FN} rename to fn_bind_rep_sms_inbound_stamp_s1_off`);
        await admin.query("notify pgrst, 'reload schema'");
        await sleep(300);
        try {
          const outcome = await dispatchRepSms({ propertyId: w.property, assignmentId: w.sender, idempotencyKey: randomUUID(), composition, inboundMessageId: w.x }) as { status?: string };
          if (outcome.status !== "sent") throw new Error(`dispatchRepSms did not send: ${JSON.stringify(outcome)}`);
        } finally {
          await admin.query("alter function public.fn_bind_rep_sms_inbound_stamp_s1_off(text,uuid,uuid,uuid) rename to fn_bind_rep_sms_inbound_stamp");
          await admin.query("notify pgrst, 'reload schema'");
        }
        const row = (await admin.query("select * from public.my_leads_work_classified($1,$2,$3)", [w.ctx.org, w.ctx.rep, new Date(Date.now() + 5 * SEC).toISOString()])).rows.find((r) => r.property_id === w.property);
        const meta = (await admin.query("select metadata from public.messages where property_id=$1 and direction='outbound'", [w.property])).rows[0]?.metadata;
        lane.runs += 1;
        if (!(meta?.inbound_stamp_unresolved === true && !meta?.inbound_message_id && row.row_no === "5")) {
          lane.failures += 1;
          lane.samples.push({ rep: n, row: row.row_no, outboundMetadata: meta });
        }
      }
    } finally {
      const missing = await admin.query("select to_regprocedure('public.fn_bind_rep_sms_inbound_stamp(text,uuid,uuid,uuid)') as f");
      if (!missing.rows[0].f) await admin.query("alter function public.fn_bind_rep_sms_inbound_stamp_s1_off(text,uuid,uuid,uuid) rename to fn_bind_rep_sms_inbound_stamp");
      await admin.end();
    }
    lanes.push(lane);
    expect(lane.failures).toBe(0);
  }, 600_000);

  it("writes dispatch-lanes.json for the main report", () => {
    mkdirSync(OUT, { recursive: true });
    const payload = skip
      ? [{ id: "race:dispatch_stamped_send_vs_inbound", title: "dispatchRepSms race", runs: 0, failures: 0, skipped: skip, samples: [] }]
      : lanes;
    const sha = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
    writeFileSync(path.join(OUT, "dispatch-lanes.json"), JSON.stringify({ sha, reps: REPS, lanes: payload }, null, 2));
    expect(true).toBe(true);
  });
});
