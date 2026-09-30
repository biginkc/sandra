import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "pg";

import {
  EXPECTED_CATALOG_FINGERPRINT,
  ReconciliationCommitted,
  SOURCE_WRITERS,
  attestationDigest,
  catalogFingerprint,
  collectEvidence,
  connectionConfig,
  digestJson,
  reconcileAndMaybeWrite,
  reconciliationExitCode,
} from "./inbox-reconcile-completion.mjs";
import { projectionRound } from "../services/inbox-projection-worker/core.mjs";

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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function drainProjection(client, { maxRounds = 30 } = {}) {
  let last;
  for (let round = 0; round < maxRounds; round++) {
    last = await projectionRound(client, { batchSize: 25 });
    const pending = (await client.query(
      `SELECT count(*) FILTER (WHERE q.org_id IS NOT NULL)::int AS queue_pending,
              count(*) FILTER (WHERE r.org_id IS NULL OR r.source_generation<>d.generation)::int AS capture_pending
         FROM inbox_message_capture.dirty d
         LEFT JOIN inbox_maintained.rows r USING(org_id,target_kind,target_id)
         LEFT JOIN inbox_maintained.queue q USING(org_id,target_kind,target_id)`,
    )).rows[0];
    if (Number(pending.queue_pending) === 0 && Number(pending.capture_pending) === 0) return last;
  }
  assert.fail(`projection worker did not drain: ${JSON.stringify(last)}`);
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
    duplicateContact: randomUUID(),
    duplicateProperty: randomUUID(),
    conversation: randomUUID(),
    message: randomUUID(),
  };
  await client.query("UPDATE inbox_control.rollout SET serving_enabled=false,backfill_complete=false,reconciliation_complete=false WHERE singleton");
  await client.query("UPDATE inbox_control.baseline_progress SET stage='done',cursor=NULL WHERE singleton");
  await client.query("INSERT INTO public.organizations(id,name) VALUES($1,$2)", [ids.org, `Inbox RT ${ids.org}`]);
  await client.query("INSERT INTO public.contacts(id,org_id,first_name,last_name) VALUES($1,$2,'Runtime','Fixture')", [ids.contact, ids.org]);
  await client.query("INSERT INTO public.properties(id,org_id,address,state,status,homeowner_contact_id) VALUES($1,$2,'100 Runtime Way','MO','contacted',$3)", [ids.property, ids.org, ids.contact]);
  await client.query("INSERT INTO public.contacts(id,org_id,first_name,last_name) VALUES($1,$2,'Duplicate','Fixture')", [ids.duplicateContact, ids.org]);
  await client.query("INSERT INTO public.properties(id,org_id,address,state,status,homeowner_contact_id) VALUES($1,$2,'101 Runtime Way','MO','contacted',$3)", [ids.duplicateProperty, ids.org, ids.duplicateContact]);
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

    const duplicateConversation = randomUUID();
    const duplicateThreadIds = [randomUUID(), randomUUID()];
    await client.query("ALTER TABLE public.message_threads DISABLE TRIGGER zzzzz_inbox_backfill_collision");
    try {
      for (const [index, threadId] of duplicateThreadIds.entries()) {
        await client.query(
          "INSERT INTO public.message_threads(id,org_id,channel,contact_id,property_id,conversation_id) VALUES($1,$2,'sms',$3,$4,$5)",
          [threadId, ids.org, index === 0 ? ids.contact : ids.duplicateContact, index === 0 ? ids.duplicateProperty : ids.property, duplicateConversation],
        );
      }
    } finally {
      await client.query("ALTER TABLE public.message_threads ENABLE TRIGGER zzzzz_inbox_backfill_collision");
    }
    await publishKnown(client, { org: ids.org, conversation: duplicateConversation });
    await client.query("DELETE FROM inbox_maintained.queue WHERE org_id=$1 AND target_id=$2", [ids.org, duplicateConversation]);
    let duplicateEvidence = await collectEvidence(client, base);
    assert.equal(duplicateEvidence.status, "blocked", "a base-table duplicate must block even without eligible messages");
    assert.equal(duplicateEvidence.checks.no_base_table_duplicates, false);
    assert.equal(duplicateEvidence.base_table_duplicates.duplicate_group_count, 1);
    result = await reconcileAndMaybeWrite(client, { ...base, writeMarkers: true });
    assert.equal(result.status, "blocked", "marker gate must independently reject a bypass-created duplicate");
    assert.equal(result.evidence.checks.no_base_table_duplicates, false);
    result = await reconcileAndMaybeWrite(client, { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, recoverCaptureBypass: true });
    assert.equal(result.status, "blocked", "recovery gate must independently reject a bypass-created duplicate");
    assert.equal(result.evidence.checks.no_base_table_duplicates, false);
    await client.query("DELETE FROM public.message_threads WHERE org_id=$1 AND conversation_id=$2", [ids.org, duplicateConversation]);
    await client.query("DELETE FROM inbox_backfill.collisions WHERE org_id=$1 AND conversation_id=$2", [ids.org, duplicateConversation]);
    await client.query("DELETE FROM inbox_maintained.queue WHERE org_id=$1 AND target_id=$2", [ids.org, duplicateConversation]);
    await client.query("DELETE FROM inbox_maintained.rows WHERE org_id=$1 AND target_id=$2", [ids.org, duplicateConversation]);
    await client.query("DELETE FROM inbox_message_capture.dirty WHERE org_id=$1 AND target_id=$2", [ids.org, duplicateConversation]);
    await client.query("DELETE FROM inbox_bridge.summaries WHERE org_id=$1 AND target_id=$2", [ids.org, duplicateConversation]);
    await client.query("DELETE FROM inbox_bridge.filter_rows WHERE org_id=$1 AND target_id=$2", [ids.org, duplicateConversation]);

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

    await client.query("UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton");
    result = await reconcileAndMaybeWrite(client, { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, recoverCaptureBypass: true });
    assert.equal(result.status, "blocked", "recovery must be blocked by serving_enabled, not by reconciliation status");
    assert.equal(result.evidence.error_code, "RECOVERY_GATE_SERVING_DISABLED");
    await client.query("UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton");

    await client.query("UPDATE inbox_control.rollout SET backfill_complete=false,reconciliation_complete=false WHERE singleton");
    const beforeRecovery = (await client.query("SELECT generation::text AS generation FROM inbox_capture_boundary.generation WHERE singleton")).rows[0].generation;
    await client.query("ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct");
    try {
      await client.query("UPDATE public.messages SET body='Real bypass recovery source' WHERE id=$1", [ids.message]);
    } finally {
      await client.query("ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct");
    }
    result = await reconcileAndMaybeWrite(client, { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, recoverCaptureBypass: true });
    assert.equal(result.status, "recovery-dry-run");
    assert.equal((await client.query("SELECT generation::text AS generation FROM inbox_capture_boundary.generation WHERE singleton")).rows[0].generation, beforeRecovery);
    assert.equal(result.evidence.checks.recovery_gate, false, "the dry-run must expose the bypass diff");
    assert.ok(result.evidence.planned.marker_key_count > 0, "the bypass key must be the only marker work");

    let writerPromise = null;
    let writerStartedAt = null;
    let writerElapsedMs = null;
    const recoveryWriterMessage = randomUUID();
    const concurrentRecoveryOptions = {
      expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT,
      recoverCaptureBypass: true,
      applyCaptureRecovery: true,
      recoveryBatchSize: 1,
      onRecoveryBatchBeforeCommit: async ({ kind, rows = [] }) => {
        if (kind !== "targets" || writerPromise || !rows.some((row) => String(row.org_id) === ids.org && String(row.target_id) === ids.conversation)) return;
        writerStartedAt = Date.now();
        writerPromise = peer.query(`
          INSERT INTO public.messages(id,org_id,channel,direction,status,property_id,contact_id,conversation_id,from_address,to_address,body,created_at)
          VALUES($1,$2,'sms','inbound','received',$3,$4,$5,'+18165550103','+18162804181','Recovery concurrent writer',clock_timestamp())
        `, [recoveryWriterMessage, ids.org, ids.property, ids.contact, ids.conversation]);
        // Keep the marker transaction open after it acquired the dirty-row
        // lock. This is a two-session mid-batch wait, not a pre-COMMIT-only
        // timing hook (T4/T14, research-reconcile-recovery-locking.md).
        await delay(50);
      },
      onRecoveryBatchCommitted: async ({ kind }) => {
        if (kind === "targets" && writerPromise && writerElapsedMs === null) {
          await writerPromise;
          writerElapsedMs = Date.now() - writerStartedAt;
        }
      },
    };
    result = await reconcileAndMaybeWrite(client, concurrentRecoveryOptions);
    assert.equal(result.status, "recovery-written");
    assert.equal(result.evidence.checks.recovery_gate, true, "a captured write during recovery is pending work, not a cross-time failure");
    assert.ok(writerElapsedMs !== null, "the writer must overlap a recovery target batch");
    assert.ok(writerElapsedMs < 500, `existing-conversation writer waited ${writerElapsedMs}ms for recovery; marker transaction exceeded the tight bound`);
    await drainProjection(client);
    const postBypass = await collectEvidence(client, base);
    assert.equal(postBypass.checks.projection_reconciled, true, "the real trigger-disabled bypass must be repaired by the projection worker");
    assert.equal(postBypass.checks.filter_reconciled, true);
    assert.equal(postBypass.checks.no_pending_work, true);
    await peer.query("DELETE FROM public.messages WHERE id=$1", [recoveryWriterMessage]);
    await drainProjection(client);

    await client.query("ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct");
    try {
      await client.query("UPDATE public.messages SET body='Interrupted bypass recovery source' WHERE id=$1", [ids.message]);
    } finally {
      await client.query("ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct");
    }
    let interrupted = false;
    await assert.rejects(
      reconcileAndMaybeWrite(client, {
        expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT,
        recoverCaptureBypass: true,
        applyCaptureRecovery: true,
        recoveryBatchSize: 1,
        onRecoveryBatchCommitted: async ({ kind }) => {
          if (kind === "targets" && !interrupted) {
            interrupted = true;
            throw new Error("test interruption after committed recovery batch");
          }
        },
      }),
      (error) => error instanceof ReconciliationCommitted && error.code === "RECOVERY_COMMITTED_POSTCHECK_FAILED",
    );
    assert.equal(interrupted, true, "the interruption must occur after a committed batch");
    const resumedDryRun = await reconcileAndMaybeWrite(client, { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, recoverCaptureBypass: true });
    assert.equal(resumedDryRun.status, "recovery-dry-run");
    assert.equal(resumedDryRun.evidence.planned.marker_key_count, 0, "the committed marker is pending worker work, not a cursor to repeat");
    result = await reconcileAndMaybeWrite(client, { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, recoverCaptureBypass: true, applyCaptureRecovery: true });
    assert.equal(result.status, "recovery-written");
    assert.equal(result.recovery.capture_generation_before, result.recovery.capture_generation_after, "no read boundaries means reruns do not bump the global generation");
    await drainProjection(client);
    assert.equal((await collectEvidence(client, base)).checks.projection_reconciled, true);

    const beforeConsistentRerun = (await client.query(
      "SELECT d.generation, g.generation::text AS capture_generation FROM inbox_message_capture.dirty d CROSS JOIN inbox_capture_boundary.generation g WHERE d.org_id=$1 AND d.target_id=$2 AND d.target_kind='known_conversation' AND g.singleton",
      [ids.org, ids.conversation],
    )).rows[0];
    result = await reconcileAndMaybeWrite(client, { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, recoverCaptureBypass: true, applyCaptureRecovery: true });
    assert.equal(result.status, "recovery-written");
    assert.equal(result.recovery.rebuild.marker_rows, 0, "a consistent rerun must not bump the key");
    const afterConsistentRerun = (await client.query(
      "SELECT d.generation, g.generation::text AS capture_generation FROM inbox_message_capture.dirty d CROSS JOIN inbox_capture_boundary.generation g WHERE d.org_id=$1 AND d.target_id=$2 AND d.target_kind='known_conversation' AND g.singleton",
      [ids.org, ids.conversation],
    )).rows[0];
    assert.deepEqual(afterConsistentRerun, beforeConsistentRerun, "a consistent rerun must not bump the global generation either");
    assert.equal(result.evidence.checks.no_base_table_duplicates, true);
    assert.equal(reconciliationExitCode(new ReconciliationCommitted("TEST")), 3);
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

test("two-session dirty markers use SKIP LOCKED and keep writer waits bounded", { skip: !RUN }, async () => {
  const client = new Client({ connectionString: BASE_DSN });
  const peer = new Client({ connectionString: BASE_DSN });
  await client.connect();
  await peer.connect();
  let ids;
  try {
    ids = await seed(client);
    const peerPid = (await peer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;

    await client.query("BEGIN");
    await client.query("UPDATE inbox_message_capture.dirty SET generation=generation+1 WHERE org_id=$1 AND target_id=$2 AND target_kind='known_conversation'", [ids.org, ids.conversation]);
    const blockedWriter = peer.query(`
      INSERT INTO public.messages(id,org_id,channel,direction,status,property_id,contact_id,conversation_id,from_address,to_address,body,created_at)
      VALUES($1,$2,'sms','inbound','received',$3,$4,$5,'+18165550104','+18162804181','same-key lock proof',clock_timestamp())
    `, [randomUUID(), ids.org, ids.property, ids.contact, ids.conversation]);
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = (await client.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [peerPid])).rows[0];
      if (state?.wait_event_type === "Lock") {
        waiting = true;
        break;
      }
      await delay(5);
    }
    assert.equal(waiting, true, "the same-key writer must visibly wait on the recovery marker lock");
    await client.query("COMMIT");
    await blockedWriter;

    const otherConversation = randomUUID();
    await client.query("INSERT INTO inbox_message_capture.dirty(org_id,target_kind,target_id,generation) VALUES($1,'known_conversation',$2,1)", [ids.org, otherConversation]);
    await peer.query("BEGIN");
    await peer.query(`
      INSERT INTO public.messages(id,org_id,channel,direction,status,property_id,contact_id,conversation_id,from_address,to_address,body,created_at)
      VALUES($1,$2,'sms','inbound','received',$3,$4,$5,'+18165550105','+18162804181','skip-locked writer',clock_timestamp())
    `, [randomUUID(), ids.org, ids.property, ids.contact, ids.conversation]);
    await client.query("BEGIN");
    const picked = (await client.query(
      `SELECT d.target_id::text AS target_id
         FROM inbox_message_capture.dirty d
        WHERE d.org_id=$1 AND d.target_id=ANY($2::uuid[])
        ORDER BY d.target_id
        FOR NO KEY UPDATE SKIP LOCKED`,
      [ids.org, [ids.conversation, otherConversation]],
    )).rows;
    assert.deepEqual(picked.map((row) => row.target_id), [otherConversation], "a locked key is retried, never silently consumed");
    const peerCommitStarted = Date.now();
    await peer.query("COMMIT");
    assert.ok(Date.now() - peerCommitStarted < 500, "SKIP LOCKED must not hold the writer behind the recovery session");
    await client.query("COMMIT");
  } finally {
    await peer.query("ROLLBACK").catch(() => {});
    await client.query("ROLLBACK").catch(() => {});
    if (ids) await cleanup(client, ids);
    await peer.end();
    await client.end();
  }
});

test("the recovery gate passes from one snapshot while a writer transaction is active", { skip: !RUN }, async () => {
  const client = new Client({ connectionString: BASE_DSN });
  const peer = new Client({ connectionString: BASE_DSN });
  await client.connect();
  await peer.connect();
  let ids;
  let activeWriterPromise;
  let writerActive = false;
  try {
    ids = await seed(client);
    await client.query("ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct");
    try {
      await client.query("UPDATE public.messages SET body='active-gate bypass' WHERE id=$1", [ids.message]);
    } finally {
      await client.query("ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct");
    }
    let writerReady;
    const writerIsReady = new Promise((resolve) => { writerReady = resolve; });
    const gateConversation = randomUUID();
    activeWriterPromise = (async () => {
      await peer.query("BEGIN");
      await peer.query(`
        INSERT INTO public.messages(id,org_id,channel,direction,status,property_id,contact_id,conversation_id,from_address,to_address,body,created_at)
        VALUES($1,$2,'sms','inbound','received',$3,$4,$5,'+18165550106','+18162804181','writer active during gate',clock_timestamp())
      `, [randomUUID(), ids.org, ids.property, ids.contact, gateConversation]);
      writerActive = true;
      writerReady();
      await delay(2000);
      await peer.query("COMMIT");
      writerActive = false;
    })();
    const result = await reconcileAndMaybeWrite(client, {
      expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT,
      recoverCaptureBypass: true,
      applyCaptureRecovery: true,
      recoveryBatchSize: 1,
      onRecoveryBatchBeforeCommit: async ({ kind, rows = [] }) => {
        if (kind === "targets" && rows.some((row) => String(row.target_id) === ids.conversation)) await writerIsReady;
      },
    });
    assert.equal(result.status, "recovery-written");
    assert.equal(result.evidence.checks.recovery_gate, true, "the RR gate must prove the snapshot, not wait for a quiet database");
    assert.equal(writerActive, true, "the proof must overlap an active writer transaction");
    await activeWriterPromise;
    await drainProjection(client);
  } finally {
    await activeWriterPromise?.catch(() => {});
    await peer.query("ROLLBACK").catch(() => {});
    if (ids) await cleanup(client, ids);
    await peer.end();
    await client.end();
  }
});

test("route-edge recovery serializes the source row before an atomic upsert", { skip: !RUN }, async () => {
  const client = new Client({ connectionString: BASE_DSN });
  const peer = new Client({ connectionString: BASE_DSN });
  await client.connect();
  await peer.connect();
  let ids;
  let writerPromise;
  let writerWaitObserved = false;
  try {
    ids = await seed(client);
    const peerPid = (await peer.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await client.query("ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct");
    try {
      await client.query("UPDATE public.messages SET from_address='+18165550999' WHERE id=$1", [ids.message]);
    } finally {
      await client.query("ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct");
    }
    const result = await reconcileAndMaybeWrite(client, {
      expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT,
      recoverCaptureBypass: true,
      applyCaptureRecovery: true,
      onRecoveryRouteEdgeCandidates: async (rows) => {
        if (!rows.some((row) => String(row.id) === ids.message) || writerPromise) return;
        writerPromise = peer.query("UPDATE public.messages SET from_address='not-a-phone' WHERE id=$1", [ids.message]);
        for (let attempt = 0; attempt < 100; attempt++) {
          const state = (await client.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [peerPid])).rows[0];
          if (state?.wait_event_type === "Lock") {
            writerWaitObserved = true;
            break;
          }
          await delay(2);
        }
        await delay(50);
      },
      onRecoveryBatchCommitted: async ({ kind }) => {
        if (kind === "route-edges" && writerPromise) await writerPromise;
      },
    });
    assert.equal(result.status, "recovery-written");
    assert.ok(writerPromise, "the writer must overlap the route-edge repair");
    assert.equal(writerWaitObserved, true, "route-edge repair must hold the source-row lock while the candidate is applied");
    assert.equal((await client.query("SELECT 1 FROM inbox_message_capture.route_edges WHERE org_id=$1 AND message_id=$2", [ids.org, ids.message])).rowCount, 0, "a writer that removes the phone must not leave a stale recovery edge");
  } finally {
    if (writerPromise) await writerPromise.catch(() => {});
    if (ids) await cleanup(client, ids);
    await peer.end();
    await client.end();
  }
});

test("a held route source lock reports incomplete recovery, then reruns cleanly after release", { skip: !RUN }, async () => {
  const client = new Client({ connectionString: BASE_DSN });
  const peer = new Client({ connectionString: BASE_DSN });
  await client.connect();
  await peer.connect();
  let ids;
  try {
    ids = await seed(client);
    await client.query("UPDATE inbox_control.rollout SET backfill_complete=false,reconciliation_complete=false WHERE singleton");
    await client.query("ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct");
    try {
      await client.query("UPDATE public.messages SET from_address='+18165550998' WHERE id=$1", [ids.message]);
    } finally {
      await client.query("ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct");
    }

    await peer.query("BEGIN");
    await peer.query("SELECT id FROM public.messages WHERE id=$1 FOR UPDATE", [ids.message]);
    let result = await reconcileAndMaybeWrite(client, {
      expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT,
      recoverCaptureBypass: true,
      applyCaptureRecovery: true,
    });
    assert.equal(result.status, "recovery-incomplete", "a skipped route repair must never report recovery success");
    assert.equal(result.recovery.incomplete_reason, "ROUTE_EDGE_REPAIRS_SKIPPED");
    assert.ok(result.recovery.rebuild.route_repairs_skipped > 0);
    assert.ok(result.recovery.rebuild.route_retries > 0, "a skipped route repair must be retried with bounded backoff");
    assert.equal(result.evidence.checks.route_edges_reconciled, false);

    await peer.query("COMMIT");
    result = await reconcileAndMaybeWrite(client, {
      expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT,
      recoverCaptureBypass: true,
      applyCaptureRecovery: true,
    });
    assert.equal(result.status, "recovery-written");
    assert.equal(result.evidence.checks.route_edges_reconciled, true);
    assert.equal(result.evidence.checks.recovery_gate, true);
    assert.deepEqual((await client.query(
      "SELECT phone_e164 FROM inbox_message_capture.route_edges WHERE org_id=$1 AND message_id=$2",
      [ids.org, ids.message],
    )).rows, [{ phone_e164: "+18165550998" }]);
  } finally {
    await peer.query("ROLLBACK").catch(() => {});
    if (ids) await cleanup(client, ids);
    await peer.end();
    await client.end();
  }
});

test("route-edge reconciliation mirrors canonical eligibility and gates markers", { skip: !RUN }, async () => {
  const client = new Client({ connectionString: BASE_DSN });
  await client.connect();
  let ids;
  try {
    ids = await seed(client);
    const nullConversationMessage = randomUUID();
    const nonSmsMessage = randomUUID();
    // The real schema fills conversation_id for contact-bearing SMS rows. Keep
    // this phone-bearing row genuinely null-conversation so the route trigger's
    // canonical predicate is tested rather than the identity-filling trigger.
    await client.query(`
      INSERT INTO public.messages(
        id,org_id,channel,direction,status,property_id,contact_id,conversation_id,
        from_address,to_address,body,created_at
      ) VALUES
        ($1,$2,'sms','inbound','received',$3,NULL,NULL,'+18165550121','+18162804181','null conversation',clock_timestamp()),
        ($5,$2,'email','outbound','sent',$3,$4,$6,'sender@example.com','recipient@example.com','non-SMS message',clock_timestamp())
    `, [nullConversationMessage, ids.org, ids.property, ids.contact, nonSmsMessage, ids.conversation]);
    const unexpectedEdges = (await client.query(
      "SELECT message_id::text AS message_id FROM inbox_message_capture.route_edges WHERE org_id=$1 AND message_id=ANY($2::uuid[]) ORDER BY message_id",
      [ids.org, [nullConversationMessage, nonSmsMessage]],
    )).rows;
    assert.deepEqual(unexpectedEdges, [], `canonical trigger must not create edges for null-conversation or non-SMS rows: ${JSON.stringify({ nullConversationMessage, nonSmsMessage, unexpectedEdges })}`);

    await client.query("ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct");
    try {
      await client.query("UPDATE public.messages SET conversation_id=NULL WHERE id=$1", [ids.message]);
    } finally {
      await client.query("ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct");
    }
    const generation = (await client.query("SELECT generation::text AS generation FROM inbox_capture_boundary.generation WHERE singleton")).rows[0].generation;
    const sourceWriterAttestation = attestation(generation);
    const base = { expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT, sourceWriterAttestation };
    let result = await collectEvidence(client, base);
    assert.equal(result.status, "blocked");
    assert.equal(result.checks.route_edges_reconciled, false, "the independent route snapshot must see the now-ineligible edge");
    assert.ok(result.route_edges.extra_count > 0);

    result = await reconcileAndMaybeWrite(client, { ...base, writeMarkers: true });
    assert.equal(result.status, "blocked", "route-edge mismatch must block completion markers");
    assert.equal(result.evidence.checks.route_edges_reconciled, false);
    assert.deepEqual((await client.query(
      "SELECT backfill_complete,reconciliation_complete FROM inbox_control.rollout WHERE singleton",
    )).rows[0], { backfill_complete: false, reconciliation_complete: false });

    result = await reconcileAndMaybeWrite(client, {
      expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT,
      recoverCaptureBypass: true,
      applyCaptureRecovery: true,
    });
    assert.equal(result.status, "recovery-written");
    assert.equal(result.evidence.checks.route_edges_reconciled, true);
    assert.equal((await client.query(
      "SELECT count(*)::int AS count FROM inbox_message_capture.route_edges WHERE org_id=$1 AND message_id=ANY($2::uuid[])",
      [ids.org, [ids.message, nullConversationMessage, nonSmsMessage]],
    )).rows[0].count, 0, "recovery must remove the now-ineligible edge and preserve the canonical no-edge cases");
  } finally {
    if (ids) await cleanup(client, ids);
    await client.end();
  }
});

test("the final route-edge snapshot gates recovery success", { skip: !RUN }, async () => {
  const client = new Client({ connectionString: BASE_DSN });
  await client.connect();
  let ids;
  try {
    ids = await seed(client);
    let corrupted = false;
    await assert.rejects(
      reconcileAndMaybeWrite(client, {
        expectedCatalogFingerprint: EXPECTED_CATALOG_FINGERPRINT,
        recoverCaptureBypass: true,
        applyCaptureRecovery: true,
        onRecoveryBatchCommitted: async ({ kind }) => {
          if (kind !== "stale-route-edges" || corrupted) return;
          corrupted = true;
          await client.query(
            "UPDATE inbox_message_capture.route_edges SET phone_e164='+18165550000' WHERE org_id=$1 AND message_id=$2",
            [ids.org, ids.message],
          );
        },
      }),
      (error) => error instanceof ReconciliationCommitted && error.code === "RECOVERY_COMMITTED_POSTCHECK_FAILED",
    );
    assert.equal(corrupted, true, "the final route snapshot must be reached after the route repair batches");
  } finally {
    if (ids) await cleanup(client, ids);
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
