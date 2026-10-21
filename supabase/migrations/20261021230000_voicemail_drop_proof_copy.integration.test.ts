import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";
import { copyDropProof, PROOF_BUCKET, supabaseProofCopyStore, sweepPendingProofCopies } from "@/lib/voicemail-drop/proof-copy";
import { handleDropStatusEvent, supabaseDropStatusStore } from "@/lib/voicemail-drop/status-updates";

// Real-DB proof of 20261021230000: the proof columns and their invariants,
// the private bucket, the real Storage path written by supabaseProofCopyStore,
// RLS (no member of any org reads the object; members read their own org's
// drop row only), idempotent replays, and the rollback.
const pg = new Client({ connectionString: requireLoopbackPostgresUrl(process.env.TEST_SUPABASE_DB_URL ?? "") });
const client = createTestClient();
const migration = readFileSync("supabase/migrations/20261021230000_voicemail_drop_proof_copy.sql", "utf8");
const rollback = readFileSync("supabase/rollbacks/20261021230000_voicemail_drop_proof_copy.sql", "utf8");

const orgA = randomUUID();
const orgB = randomUUID();
const memberA = randomUUID();
const memberB = randomUUID();
const dropA = randomUUID();
const dropPending = randomUUID();
const proofPath = `${orgA}/${dropA}.mp3`;

async function insertDrop(id: string, org: string) {
  const seq = randomUUID();
  await pg.query("insert into public.sequences(id,org_id,name) values ($1,$2,$3)", [seq, org, `Proof ${seq}`]);
  const step = (await pg.query(
    "insert into public.sequence_steps(sequence_id,step_index,action_type,vm_tts_body) values ($1,0,'send_voicemail_drop','Hi') returning id",
    [seq],
  )).rows[0].id;
  const prop = randomUUID();
  await pg.query("insert into public.properties(id,org_id,address,state) values ($1,$2,'1 Main','MO')", [prop, org]);
  const enr = (await pg.query(
    "insert into public.sequence_enrollments(sequence_id,property_id,org_id) values ($1,$2,$3) returning id", [seq, prop, org],
  )).rows[0].id;
  const run = (await pg.query(
    "insert into public.sequence_step_runs(enrollment_id,step_id,scheduled_for) values ($1,$2,now()) returning id",
    [enr, step],
  )).rows[0].id;
  await pg.query(
    `insert into public.voicemail_drops(id,org_id,enrollment_id,step_run_id,idempotency_key,property_id,to_phone,provider,audio_kind,
       status,attempt_outcome,drop_id)
     values ($1::uuid,$2,$3,$4,$1::text,$5,'+18165550101','dropcowboy','tts','delivered','queued',$1::text)`,
    [id, org, enr, run, prop],
  );
}

async function sqlError(text: string, params: unknown[] = []) {
  await pg.query("begin");
  try { await pg.query(text, params); return null; }
  catch (error) { return (error as { code?: string }).code ?? "error"; }
  finally { await pg.query("rollback"); }
}

async function asMember<T>(user: string, fn: () => Promise<T>): Promise<T> {
  await pg.query("begin");
  try {
    await pg.query("set local role authenticated");
    await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [user]);
    await pg.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "authenticated", sub: user })]);
    return await fn();
  } finally {
    await pg.query("rollback");
  }
}

const pub = async () => ["104.18.1.1"];
const audioFetcher = async () => new Response(new Uint8Array([73, 68, 51, 4, 0, 0, 1, 2, 3]), { headers: { "content-type": "audio/mpeg" } });

beforeAll(async () => {
  await pg.connect();
  // Re-running the migration on top of itself must be a no-op.
  await pg.query(migration);
  for (const [org, user] of [[orgA, memberA], [orgB, memberB]]) {
    await pg.query("insert into auth.users(id) values ($1)", [user]);
    await pg.query("insert into public.organizations(id,name) values ($1,$2)", [org, `Proof test ${org}`]);
    await pg.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'owner')", [user, org]);
  }
  await insertDrop(dropA, orgA);
  await insertDrop(dropPending, orgA);
});

afterAll(async () => {
  await client.storage.from(PROOF_BUCKET).remove([proofPath]);
  // Remove every row this suite created, owners included. Deleting a sole
  // owner trips the final-owner guard, so (as the Dialpad CTI suite does)
  // cleanup runs with triggers off inside one transaction. Leftover owner
  // memberships break later suites' orphan-membership prune in shared CI DBs.
  await pg.query("begin");
  try {
    await pg.query("set local session_replication_role = replica");
    const tables = await pg.query<{ table_name: string }>(
      `select c.table_name from information_schema.columns c join information_schema.tables t using (table_schema, table_name)
       where c.table_schema = 'public' and c.column_name = 'org_id' and t.table_type = 'BASE TABLE'`,
    );
    for (const { table_name } of tables.rows) {
      await pg.query(`delete from public.${table_name} where org_id = any($1)`, [[orgA, orgB]]);
    }
    await pg.query("delete from public.organizations where id = any($1)", [[orgA, orgB]]);
    await pg.query("delete from auth.users where id = any($1)", [[memberA, memberB]]);
    await pg.query("commit");
  } catch (error) {
    await pg.query("rollback");
    throw error;
  } finally {
    await pg.end();
  }
});

describe("20261021230000_voicemail_drop_proof_copy", () => {
  it("creates a private bucket with an audio-only, 25 MB limit", async () => {
    const { rows } = await pg.query("select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1", [PROOF_BUCKET]);
    expect(rows[0]).toMatchObject({ public: false, file_size_limit: "26214400" });
    expect(rows[0].allowed_mime_types).toContain("audio/mpeg");
    expect(rows[0].allowed_mime_types.every((t: string) => t.startsWith("audio/"))).toBe(true);
  });

  it("rejects a stored copy outside <org>/<drop>.<ext> or without its facts", async () => {
    const set = "update public.voicemail_drops set proof_copy_status='stored', proof_storage_path=$2, proof_content_type='audio/mpeg', proof_size_bytes=1, proof_fetched_at=now() where id=$1";
    expect(await sqlError(set, [dropA, `${orgB}/${dropA}.mp3`])).toBe("23514");
    expect(await sqlError(set, [dropA, `${orgA}/${dropA}.mp3/../x`])).toBe("23514");
    expect(await sqlError("update public.voicemail_drops set proof_copy_status='stored' where id=$1", [dropA])).toBe("23514");
    expect(await sqlError("update public.voicemail_drops set proof_copy_status='bogus' where id=$1", [dropA])).toBe("23514");
    // A path with a NULL or non-stored status is rejected too.
    const pathOnly = "update public.voicemail_drops set proof_copy_status=$2, proof_storage_path=$3, proof_content_type='audio/mpeg', proof_size_bytes=1, proof_fetched_at=now() where id=$1";
    expect(await sqlError(pathOnly, [dropA, null, proofPath])).toBe("23514");
    expect(await sqlError(pathOnly, [dropA, "pending", proofPath])).toBe("23514");
    expect(await sqlError(set, [dropA, proofPath])).toBeNull();
  });

  it("stores the real object at <org>/<drop>.mp3 and records it once under replays", async () => {
    const store = supabaseProofCopyStore(client);
    await supabaseDropStatusStore(client).saveReceiptProof(dropA, "https://api-v2.dropcowboy.com/campaign/public/receipts/tok", new Date().toISOString());
    expect(await copyDropProof(store, dropA, { fetcher: audioFetcher, resolve: pub })).toBe("stored");
    expect(await copyDropProof(store, dropA, { fetcher: audioFetcher, resolve: pub })).toBe("already_stored");
    const { rows } = await pg.query("select proof_storage_path, proof_content_type, proof_size_bytes, proof_copy_status, proof_url, proof_url_at from public.voicemail_drops where id=$1", [dropA]);
    expect(rows[0]).toMatchObject({ proof_storage_path: proofPath, proof_content_type: "audio/mpeg", proof_size_bytes: "9", proof_copy_status: "stored", proof_url: "https://api-v2.dropcowboy.com/campaign/public/receipts/tok" });
    expect(rows[0].proof_url_at).not.toBeNull();
    const objects = await pg.query("select name from storage.objects where bucket_id=$1 and name=$2", [PROOF_BUCKET, proofPath]);
    expect(objects.rowCount).toBe(1);
    const { data: signed } = await client.storage.from(PROOF_BUCKET).createSignedUrl(proofPath, 60);
    expect(signed?.signedUrl).toBeTruthy();
  });

  it("keeps a failed download pending and the sweep stores it later", async () => {
    const store = supabaseProofCopyStore(client);
    const down = async () => new Response("{}", { status: 404 });
    await supabaseDropStatusStore(client).saveReceiptProof(dropPending, "https://api-v2.dropcowboy.com/campaign/public/receipts/tok", new Date().toISOString());
    expect(await copyDropProof(store, dropPending, { fetcher: down, resolve: pub })).toBe("pending");
    await pg.query("update public.voicemail_drops set proof_copy_next_at = now() - interval '1 minute' where id=$1", [dropPending]);
    const counts = await sweepPendingProofCopies(store, { fetcher: audioFetcher, limit: 50, resolve: pub });
    expect(counts.stored).toBeGreaterThanOrEqual(1);
    const { rows } = await pg.query("select proof_copy_status, proof_storage_path from public.voicemail_drops where id=$1", [dropPending]);
    expect(rows[0]).toEqual({ proof_copy_status: "stored", proof_storage_path: `${orgA}/${dropPending}.mp3` });
    await client.storage.from(PROOF_BUCKET).remove([`${orgA}/${dropPending}.mp3`]);
    await pg.query("update public.voicemail_drops set proof_copy_status=null, proof_storage_path=null, proof_content_type=null, proof_size_bytes=null, proof_fetched_at=null where id=$1", [dropPending]);
  });

  it("a receipt is queued in one write before the ack; a failed write errors the event and a retry applies", async () => {
    const real = supabaseDropStatusStore(client);
    const eventId = `evt-${randomUUID()}`;
    const event = {
      kind: "receipt" as const, eventId, eventAt: null, dropId: dropPending, to: null, contactId: null, campaignType: "rvm",
      status: "success" as const, reason: null, reasonCode: 0, reasonClass: "success" as never,
      proofUrl: "https://api-v2.dropcowboy.com/campaign/public/receipts/new", receiptReadyAt: null, raw: { event_id: eventId },
    };
    await pg.query("update public.voicemail_drops set proof_url=null, proof_url_at=null, proof_copy_status=null, proof_copy_next_at=null where id=$1", [dropPending]);
    // A real DB failure inside the single write (an invalid timestamp).
    const broken = { ...real, saveReceiptProof: (id: string, url: string) => real.saveReceiptProof(id, url, "not-a-time") };
    await expect(handleDropStatusEvent(broken, event)).rejects.toThrow(/saveReceiptProof/);
    const failed = await pg.query("select proof_url, proof_url_at, proof_copy_status from public.voicemail_drops where id=$1", [dropPending]);
    expect(failed.rows[0]).toEqual({ proof_url: null, proof_url_at: null, proof_copy_status: null });
    const ev = await pg.query("select processing_status from public.webhook_events where provider='dropcowboy' and external_id=$1", [eventId]);
    expect(ev.rows[0].processing_status).toBe("error");

    const copy = vi.fn(async () => { throw new Error("copy crashed"); });
    expect(await handleDropStatusEvent(real, event, new Date(), { onProofUrl: copy })).toBe("applied");
    const ok = await pg.query("select proof_url, proof_url_at, proof_copy_status, proof_copy_next_at from public.voicemail_drops where id=$1", [dropPending]);
    expect(ok.rows[0]).toMatchObject({ proof_url: event.proofUrl, proof_copy_status: "pending" });
    expect(ok.rows[0].proof_url_at).not.toBeNull();
    expect(ok.rows[0].proof_copy_next_at).not.toBeNull();
    // Even though the copy crashed, the sweep picks the row up.
    const due = await supabaseProofCopyStore(client).listDue(new Date(Date.now() + 1000).toISOString(), 500);
    expect(due).toContain(dropPending);
  });

  it("RLS: no member reads the stored object; only the drop's own org reads the drop row", async () => {
    for (const user of [memberA, memberB]) {
      const objects = await asMember(user, () =>
        pg.query("select name from storage.objects where bucket_id=$1", [PROOF_BUCKET]));
      expect(objects.rowCount).toBe(0);
    }
    const own = await asMember(memberA, () => pg.query("select proof_storage_path from public.voicemail_drops where id=$1", [dropA]));
    expect(own.rows).toEqual([{ proof_storage_path: proofPath }]);
    const other = await asMember(memberB, () => pg.query("select proof_storage_path from public.voicemail_drops where id=$1", [dropA]));
    expect(other.rowCount).toBe(0);
    const write = await asMember(memberA, async () => {
      try { await pg.query("update public.voicemail_drops set proof_storage_path=null where id=$1", [dropA]); return null; }
      catch (error) { return (error as { code?: string }).code; }
    });
    expect(write).toBe("42501");
  });

  it("rollback refuses while a copy is stored, and removes the columns once none is", async () => {
    expect(await sqlError(rollback.replace(/^begin;$/m, "").replace(/^commit;$/m, ""))).toBe("P0001");
    // Storage forbids SQL deletes; empty the bucket through the Storage API.
    expect((await client.storage.from(PROOF_BUCKET).remove([proofPath])).error).toBeNull();
    await pg.query("begin");
    try {
      await pg.query("update public.voicemail_drops set proof_copy_status=null, proof_storage_path=null where org_id=$1", [orgA]);
      await pg.query(rollback.replace(/^begin;$/m, "").replace(/^commit;$/m, ""));
      const cols = await pg.query("select column_name from information_schema.columns where table_schema='public' and table_name='voicemail_drops' and column_name like 'proof_%'");
      expect(cols.rows.map((r) => r.column_name)).toEqual(["proof_url"]);
    } finally {
      await pg.query("rollback");
    }
  });
});
