import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

import {
  EXPECTED_CATALOG_FINGERPRINT,
  SOURCE_WRITERS,
  attestationDigest,
  catalogFingerprint,
  collectEvidence,
  connectionConfig,
  digestJson,
  reconcileAndMaybeWrite,
} from "./inbox-reconcile-completion.mjs";

const BASE_DSN = process.env.INBOX_RECONCILIATION_TEST_DATABASE_URL;
const RUN = Boolean(BASE_DSN);

if (!RUN) {
  test("R6a real-schema integration requires INBOX_RECONCILIATION_TEST_DATABASE_URL", () => {
    assert.fail("Set INBOX_RECONCILIATION_TEST_DATABASE_URL to a disposable Postgres 17 database; the real-schema proof must not be silently skipped");
  });
}

function attestation(generation) {
  const payload = {
    capture_generation: generation,
    bypass_since_install: false,
    covered_tables: [...new Set(SOURCE_WRITERS.map(([table]) => table))],
    catalog_fingerprint: EXPECTED_CATALOG_FINGERPRINT,
  };
  return { ...payload, operator_assertion_digest: attestationDigest(payload) };
}

function orgDigest(orgId) {
  return createHash("sha256").update(`org:${orgId}`).digest("hex");
}

async function publishKnown(client, ids) {
  const candidate = (await client.query(
    "SELECT inbox_maintained.snapshot($1,'known_conversation',$2,$3) AS candidate",
    [ids.org, ids.conversation, new Date().toISOString()],
  )).rows[0]?.candidate;
  assert.ok(candidate, "J5a snapshot must produce the seeded candidate");
  const result = (await client.query("SELECT inbox_maintained.publish($1) AS result", [candidate])).rows[0].result;
  assert.ok(["applied", "already_applied"].includes(result));
  if (result === "already_applied") {
    await client.query(
      `UPDATE inbox_maintained.rows
          SET revision=$1,source_generation=$2,summary=$3,next_expiry=$4
        WHERE org_id=$5 AND target_kind=$6 AND target_id=$7`,
      [candidate.expected_revision, candidate.generation, candidate.summary, candidate.summary.next_window_expiry, candidate.org_id, candidate.target_kind, candidate.target_id],
    );
  }
}

async function seed(client) {
  for (const table of [
    "inbox_read.boundaries", "inbox_bridge.summaries", "inbox_bridge.filter_rows", "inbox_maintained.queue",
    "inbox_maintained.rows", "inbox_message_capture.route_edges", "inbox_message_capture.dirty",
    "inbox_message_capture.sender_groups", "inbox_message_capture.sender_buckets", "inbox_parent.work",
    "inbox_safety.routes", "inbox_backfill.collisions", "inbox_backfill.jobs", "inbox_policy.versions",
    "inbox_operation_domain.target_versions", "inbox_operation_domain.sms_scopes", "inbox_reply_context.versions",
  ]) {
    await client.query(`DELETE FROM ${table} d WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id=d.org_id)`);
  }
  const ids = {
    org: randomUUID(),
    contact: randomUUID(),
    property: randomUUID(),
    conversation: randomUUID(),
    message: randomUUID(),
  };
  await client.query("UPDATE inbox_control.rollout SET serving_enabled=false,backfill_complete=false,reconciliation_complete=false WHERE singleton");
  await client.query("UPDATE inbox_control.baseline_progress SET stage='done',cursor=NULL WHERE singleton");
  await client.query("INSERT INTO public.organizations(id,name) VALUES($1,$2)", [ids.org, `Inbox RT ${ids.org}`]);
  await client.query("INSERT INTO public.contacts(id,org_id,first_name,last_name) VALUES($1,$2,'Runtime','Fixture')", [ids.contact, ids.org]);
  await client.query("INSERT INTO public.properties(id,org_id,address,state,status,homeowner_contact_id) VALUES($1,$2,'100 Runtime Way','MO','contacted',$3)", [ids.property, ids.org, ids.contact]);
  await client.query("INSERT INTO public.message_threads(org_id,channel,contact_id,property_id,conversation_id) VALUES($1,'sms',$2,$3,$4)", [ids.org, ids.contact, ids.property, ids.conversation]);
  await client.query(`
    INSERT INTO public.messages(id,org_id,channel,direction,status,property_id,contact_id,conversation_id,from_address,to_address,body,created_at)
    VALUES($1,$2,'sms','inbound','received',$3,$4,$5,'+18165550101','+18162804181','Runtime reconciliation fixture',clock_timestamp())
  `, [ids.message, ids.org, ids.property, ids.contact, ids.conversation]);

  const organizations = (await client.query("SELECT id FROM public.organizations ORDER BY id")).rows;
  for (const { id } of organizations) {
    const job = (await client.query("SELECT 1 FROM inbox_backfill.jobs WHERE org_id=$1", [id])).rowCount;
    if (!job) await client.query("SELECT inbox_backfill.start($1)", [id]);
  }
  await client.query("UPDATE inbox_backfill.jobs SET stream='done',cursor=NULL,claim_token=NULL,lease_until=NULL,capture_fingerprint=inbox_backfill.fingerprint(),completed_at=clock_timestamp()");
  await client.query("UPDATE inbox_parent.work SET ack=generation,claim_token=NULL,lease_until=NULL,scan_generation=NULL,stream=NULL,cursor=NULL");
  await client.query("UPDATE inbox_safety.routes SET ack=generation,claim_token=NULL,lease_until=NULL,scan_generation=NULL,cursor=NULL");
  await client.query("UPDATE inbox_backfill.collisions SET ack=generation,duplicate_thread_ids=NULL,checked_at=clock_timestamp()");
  await publishKnown(client, ids);
  await client.query("DELETE FROM inbox_maintained.queue");
  return ids;
}

async function cleanup(client, ids) {
  for (const table of [
    "inbox_read.boundaries", "inbox_bridge.summaries", "inbox_bridge.filter_rows", "inbox_maintained.queue",
    "inbox_maintained.rows", "inbox_message_capture.route_edges", "inbox_message_capture.dirty",
    "inbox_message_capture.sender_groups", "inbox_message_capture.sender_buckets", "inbox_parent.work",
    "inbox_safety.routes", "inbox_backfill.collisions", "inbox_backfill.jobs", "inbox_policy.versions",
    "inbox_operation_domain.target_versions", "inbox_operation_domain.sms_scopes", "inbox_reply_context.versions",
  ]) {
    await client.query(`DELETE FROM ${table} WHERE org_id=$1`, [ids.org]).catch(() => {});
  }
  await client.query("DELETE FROM public.messages WHERE org_id=$1", [ids.org]);
  await client.query("DELETE FROM public.message_threads WHERE org_id=$1", [ids.org]);
  await client.query("DELETE FROM public.properties WHERE org_id=$1", [ids.org]);
  await client.query("DELETE FROM public.contacts WHERE org_id=$1", [ids.org]);
  await client.query("DELETE FROM public.organizations WHERE id=$1", [ids.org]);
  for (const table of [
    "inbox_read.boundaries", "inbox_bridge.summaries", "inbox_bridge.filter_rows", "inbox_maintained.queue",
    "inbox_maintained.rows", "inbox_message_capture.route_edges", "inbox_message_capture.dirty",
    "inbox_message_capture.sender_groups", "inbox_message_capture.sender_buckets", "inbox_parent.work",
    "inbox_safety.routes", "inbox_backfill.collisions", "inbox_backfill.jobs", "inbox_policy.versions",
    "inbox_operation_domain.target_versions", "inbox_operation_domain.sms_scopes", "inbox_reply_context.versions",
  ]) {
    await client.query(`DELETE FROM ${table} d WHERE NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id=d.org_id)`);
  }
}

test("R6a runs against the real J5a schema and proves source, projection, filter, recovery, and write guards", { skip: !RUN }, async () => {
  const client = new Client({ connectionString: BASE_DSN });
  const peer = new Client({ connectionString: BASE_DSN });
  await client.connect();
  await peer.connect();
  let ids;
  try {
    ids = await seed(client);
    const generation = (await client.query("SELECT generation::text AS generation FROM inbox_capture_boundary.generation WHERE singleton")).rows[0].generation;
    const sourceWriterAttestation = attestation(generation);
    const base = { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, sourceWriterAttestation };

    const initial = await collectEvidence(client, base);
    assert.equal(initial.status, "ready");
    assert.equal(initial.checks.projection_reconciled, true);
    assert.equal(initial.checks.filter_reconciled, true);
    assert.equal(initial.fingerprints.expected_catalog, EXPECTED_CATALOG_FINGERPRINT);
    assert.equal(initial.fingerprints.live_catalog, EXPECTED_CATALOG_FINGERPRINT, "Committed catalog fingerprint drifted; regenerate scripts/inbox-reconcile-catalog.expected.json from the reviewed disposable schema");
    assert.equal(initial.source_writer_attestation.operator_assertion_digest, sourceWriterAttestation.operator_assertion_digest);
    assert.equal(JSON.stringify(initial).includes(ids.org), false, "evidence must not expose fixture IDs");

    await client.query("DELETE FROM inbox_maintained.rows WHERE org_id=$1 AND target_id=$2", [ids.org, ids.conversation]);
    let result = await reconcileAndMaybeWrite(client, base);
    assert.equal(result.status, "blocked");
    assert.ok(result.evidence.reconciliation.per_org.some((row) => row.maintained_missing_count > 0));
    await publishKnown(client, ids);

    await client.query("UPDATE inbox_maintained.rows SET summary=jsonb_set(summary,'{last_message_preview}',to_jsonb($2::text),true) WHERE org_id=$1 AND target_id=$3", [ids.org, "mutated maintained", ids.conversation]);
    result = await reconcileAndMaybeWrite(client, base);
    assert.equal(result.status, "blocked");
    assert.ok(result.evidence.reconciliation.per_org.some((row) => row.maintained_mismatch_count > 0));
    await publishKnown(client, ids);

    await client.query("ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct");
    let coverage = await collectEvidence(client, base);
    assert.equal(coverage.checks.source_writer_coverage, false);
    await client.query("ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct");

    await client.query("UPDATE inbox_bridge.summaries SET preview='mutated projection' WHERE org_id=$1", [ids.org]);
    result = await reconcileAndMaybeWrite(client, base);
    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.checks.projection_reconciled, false);
    await client.query("UPDATE inbox_bridge.summaries SET preview='Runtime reconciliation fixture' WHERE org_id=$1", [ids.org]);

    await client.query("UPDATE inbox_bridge.filter_rows SET unread=false WHERE org_id=$1", [ids.org]);
    result = await reconcileAndMaybeWrite(client, base);
    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.checks.filter_reconciled, false);
    await client.query("UPDATE inbox_bridge.filter_rows SET unread=true WHERE org_id=$1", [ids.org]);

    const tombstone = randomUUID();
    await client.query("INSERT INTO inbox_message_capture.dirty(org_id,target_kind,target_id,generation) VALUES($1,'known_conversation',$2,1)", [ids.org, tombstone]);
    await publishKnown(client, { org: ids.org, conversation: tombstone });
    await client.query("DELETE FROM inbox_maintained.queue WHERE org_id=$1 AND target_id=$2", [ids.org, tombstone]);
    result = await reconcileAndMaybeWrite(client, base);
    assert.equal(result.status, "ready", "a source-absent exists=false tombstone is consistent");
    let reconciliation = result.evidence.reconciliation.per_org.find((row) => row.org_digest === orgDigest(ids.org));
    assert.equal(reconciliation.maintained_extra_count, 0, "tombstones must not be classified as extras");
    assert.equal(reconciliation.maintained_mismatch_count, 0, "a correct tombstone must not be a mismatch");

    await client.query("UPDATE inbox_maintained.rows SET summary=jsonb_set(summary,'{exists}','true'::jsonb) WHERE org_id=$1 AND target_id=$2", [ids.org, tombstone]);
    result = await reconcileAndMaybeWrite(client, base);
    assert.equal(result.status, "blocked", "a maintained exists=true row with no source must fail");
    reconciliation = result.evidence.reconciliation.per_org.find((row) => row.org_digest === orgDigest(ids.org));
    assert.ok(reconciliation.maintained_mismatch_count > 0, "exists=true source-absent rows are mismatches");
    assert.equal(reconciliation.maintained_extra_count, 0, "exists=true source-absent rows are mismatches, not extras");
    await publishKnown(client, { org: ids.org, conversation: tombstone });
    await client.query("DELETE FROM inbox_maintained.queue WHERE org_id=$1 AND target_id=$2", [ids.org, tombstone]);
    await client.query("DELETE FROM inbox_maintained.rows WHERE org_id=$1 AND target_id=$2", [ids.org, tombstone]);
    await client.query("DELETE FROM inbox_message_capture.dirty WHERE org_id=$1 AND target_id=$2", [ids.org, tombstone]);
    await client.query("DELETE FROM inbox_bridge.summaries WHERE org_id=$1 AND target_id=$2", [ids.org, tombstone]);
    await client.query("DELETE FROM inbox_bridge.filter_rows WHERE org_id=$1 AND target_id=$2", [ids.org, tombstone]);

    const concurrentConversation = randomUUID();
    const concurrentMessage = randomUUID();
    result = await reconcileAndMaybeWrite(client, {
      ...base,
      writeMarkers: true,
      beforeWrite: async () => {
        await peer.query(`
          INSERT INTO public.messages(id,org_id,channel,direction,status,property_id,contact_id,conversation_id,from_address,to_address,body,created_at)
          VALUES($1,$2,'sms','inbound','received',$3,$4,$5,'+18165550102','+18162804181','Concurrent source row',clock_timestamp())
        `, [concurrentMessage, ids.org, ids.property, ids.contact, concurrentConversation]);
      },
    });
    assert.equal(result.status, "blocked", "M1 recheck=initial must fail: the in-transaction re-check must reject evidence changed after the dry-run");
    assert.equal((await client.query("SELECT backfill_complete FROM inbox_control.rollout WHERE singleton")).rows[0].backfill_complete, false);
    await peer.query("DELETE FROM public.messages WHERE id=$1", [concurrentMessage]);
    await client.query("DELETE FROM inbox_maintained.rows WHERE org_id=$1 AND target_id=$2", [ids.org, concurrentConversation]);
    await client.query("DELETE FROM inbox_message_capture.dirty WHERE org_id=$1 AND target_id=$2", [ids.org, concurrentConversation]);
    await client.query("DELETE FROM inbox_bridge.summaries WHERE org_id=$1 AND target_id=$2", [ids.org, concurrentConversation]);
    await client.query("DELETE FROM inbox_bridge.filter_rows WHERE org_id=$1 AND target_id=$2", [ids.org, concurrentConversation]);
    await client.query("DELETE FROM inbox_maintained.queue WHERE org_id=$1", [ids.org]);

    await client.query("UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton");
    result = await reconcileAndMaybeWrite(client, {
      ...base,
      writeMarkers: true,
      beforeWrite: async () => {
        await peer.query("UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton");
      },
    });
    assert.equal(result.status, "blocked", "serving_enabled guard mutation must fail during the write re-check");
    assert.deepEqual((await client.query("SELECT backfill_complete,reconciliation_complete FROM inbox_control.rollout WHERE singleton")).rows[0], { backfill_complete: false, reconciliation_complete: false });
    await client.query("UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton");

    result = await reconcileAndMaybeWrite(client, { ...base, writeMarkers: true });
    assert.equal(result.status, "written");
    result = await reconcileAndMaybeWrite(client, { ...base, writeMarkers: true });
    assert.equal(result.status, "idempotent");

    await client.query("UPDATE inbox_control.rollout SET backfill_complete=false,reconciliation_complete=false WHERE singleton");
    const beforeRecovery = (await client.query("SELECT generation::text AS generation FROM inbox_capture_boundary.generation WHERE singleton")).rows[0].generation;
    result = await reconcileAndMaybeWrite(client, { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, recoverCaptureBypass: true });
    assert.equal(result.status, "recovery-dry-run");
    assert.equal((await client.query("SELECT generation::text AS generation FROM inbox_capture_boundary.generation WHERE singleton")).rows[0].generation, beforeRecovery);
    result = await reconcileAndMaybeWrite(client, { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, recoverCaptureBypass: true, applyCaptureRecovery: true });
    assert.equal(result.status, "recovery-written");
    assert.notEqual(result.recovery.capture_generation_before, result.recovery.capture_generation_after);
    assert.equal(result.evidence.checks.full_reconciliation, true);
    assert.deepEqual((await client.query("SELECT serving_enabled,backfill_complete,reconciliation_complete FROM inbox_control.rollout WHERE singleton")).rows[0], {
      serving_enabled: false,
      backfill_complete: false,
      reconciliation_complete: false,
    });
  } finally {
    if (ids) await cleanup(client, ids);
    await peer.end();
    await client.end();
  }
});

test("committed catalog fingerprint drift fails loudly", { skip: !RUN }, async () => {
  const client = new Client({ connectionString: BASE_DSN });
  await client.connect();
  try {
    const live = await catalogFingerprint(client);
    assert.equal(live, EXPECTED_CATALOG_FINGERPRINT, "Committed catalog fingerprint drifted; regenerate scripts/inbox-reconcile-catalog.expected.json from the reviewed disposable schema");
    const drifted = await collectEvidence(client, { expectedCatalogFingerprint: "0".repeat(64) });
    assert.equal(drifted.status, "blocked");
    assert.equal(drifted.checks.catalog_fingerprint_match, false, "a catalog drift must block completion");
    assert.equal(drifted.fingerprints.expected_catalog, "0".repeat(64));
    assert.equal(drifted.fingerprints.live_catalog, live);
  } finally {
    await client.end();
  }
});

test("operator assertion digest is stable and explicitly named", () => {
  const payload = { capture_generation: "10000000-0000-0000-0000-000000000001", bypass_since_install: false, covered_tables: ["public.messages"], catalog_fingerprint: "a".repeat(64) };
  assert.equal(attestationDigest(payload), digestJson({ ...payload, covered_tables: ["public.messages"] }));
  assert.equal(attestationDigest({ ...payload, secret: "must-not-be-read" }), attestationDigest(payload));
});

test("connection boundary refuses hosted downgrade and unmarked local targets", () => {
  assert.throws(() => connectionConfig({ dsn: "postgresql://user:password@db.example.com/postgres", target: "production", env: {} }), /TLS_CA_REQUIRED/);
  assert.throws(() => connectionConfig({ dsn: "postgresql://user:password@db.example.com/postgres?sslmode=require", target: "production", env: {} }), /DATABASE_URL_TLS_QUERY_REFUSED/);
  assert.throws(() => connectionConfig({ dsn: "postgresql://user:password@127.0.0.1:54329/postgres", target: "local-fixture", env: {} }), /LOCAL_FIXTURE_NOT_AUTHORIZED/);
  assert.deepEqual(connectionConfig({ dsn: "postgresql://user:password@127.0.0.1:54329/postgres", target: "local-fixture", env: { INBOX_RECONCILIATION_LOCAL_FIXTURE: "true" } }).ssl, false);
});
