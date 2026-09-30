import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "pg";

import {
  SOURCE_WRITERS,
  attestationDigest,
  collectEvidence,
  connectionConfig,
  digestJson,
  reconcileAndMaybeWrite,
} from "./inbox-reconcile-completion.mjs";

const RUN = process.env.INBOX_RECONCILIATION_RUN_LOCAL_INTEGRATION === "1";
const BASE_DSN = process.env.INBOX_RECONCILIATION_TEST_DATABASE_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres";

function localDsn(dsn) {
  const url = new URL(dsn);
  if (url.hostname !== "127.0.0.1" || !url.port || !['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error("local integration requires a loopback PostgreSQL URL");
  }
  return url;
}

async function createDatabase() {
  const base = localDsn(BASE_DSN);
  const adminUrl = new URL(base);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const database = `inbox_reconcile_${process.pid}_${Date.now().toString(36)}`.replace(/[^a-z0-9_]/g, "_");
  await admin.query(`CREATE DATABASE "${database}"`);
  await admin.end();
  const disposable = new URL(base);
  disposable.pathname = `/${database}`;
  const client = new Client({ connectionString: disposable.toString() });
  await client.connect();
  return {
    client,
    database,
    adminUrl,
    async dispose() {
      await client.end();
      const cleanup = new Client({ connectionString: adminUrl.toString() });
      await cleanup.connect();
      await cleanup.query(`DROP DATABASE "${database}" WITH (FORCE)`);
      await cleanup.end();
    },
  };
}

async function fixture(client) {
  await client.query(`
    CREATE SCHEMA inbox_control;
    CREATE SCHEMA inbox_backfill;
    CREATE SCHEMA inbox_capture_boundary;
    CREATE SCHEMA inbox_message_capture;
    CREATE SCHEMA inbox_maintained;
    CREATE SCHEMA inbox_parent;
    CREATE SCHEMA inbox_safety;
    CREATE SCHEMA inbox_bridge;
    CREATE TABLE public.organizations(id uuid PRIMARY KEY);
    CREATE TABLE public.messages(id uuid PRIMARY KEY, org_id uuid);
    CREATE TABLE public.properties(id uuid PRIMARY KEY, org_id uuid);
    CREATE TABLE public.contacts(id uuid PRIMARY KEY, org_id uuid);
    CREATE TABLE public.ai_disposition_reviews(id uuid PRIMARY KEY, org_id uuid);
    CREATE TABLE public.consent_events(id uuid PRIMARY KEY, org_id uuid);
    CREATE TABLE public.message_threads(id uuid PRIMARY KEY, org_id uuid, conversation_id uuid);
    CREATE TABLE public.sms_phone_suppressions(id uuid PRIMARY KEY, org_id uuid);
    CREATE TABLE public.memberships(id uuid PRIMARY KEY, org_id uuid);
    CREATE SCHEMA auth;
    CREATE TABLE auth.sessions(id uuid PRIMARY KEY, user_id uuid);
    CREATE OR REPLACE FUNCTION public.inbox_test_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
    CREATE TRIGGER zzzzz_inbox_message_direct AFTER INSERT OR UPDATE OR DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzz_inbox_guard_inbound_revision_insert BEFORE INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzz_inbox_guard_inbound_revision_update BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER inbox_capture_inbound_head AFTER INSERT OR UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzz_inbox_parent AFTER INSERT OR UPDATE OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.properties FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzz_inbox_parent AFTER INSERT OR UPDATE OR DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzz_inbox_parent_review AFTER INSERT OR UPDATE OR DELETE ON public.ai_disposition_reviews FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.ai_disposition_reviews FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzz_inbox_safety_consent AFTER INSERT OR UPDATE OR DELETE ON public.consent_events FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.consent_events FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzz_inbox_safety_thread AFTER INSERT OR UPDATE OR DELETE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzz_inbox_backfill_collision AFTER INSERT OR UPDATE OR DELETE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.message_threads FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzz_inbox_safety_suppression AFTER INSERT OR UPDATE OR DELETE ON public.sms_phone_suppressions FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.sms_phone_suppressions FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzzz_inbox_policy AFTER INSERT OR UPDATE OR DELETE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzzzz_inbox_access AFTER INSERT OR UPDATE OR DELETE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER zzzzzzz_inbox_access AFTER INSERT OR UPDATE OR DELETE ON auth.sessions FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TABLE inbox_control.rollout(singleton boolean PRIMARY KEY CHECK(singleton), serving_enabled boolean NOT NULL DEFAULT false, backfill_complete boolean NOT NULL DEFAULT false, reconciliation_complete boolean NOT NULL DEFAULT false);
    INSERT INTO inbox_control.rollout(singleton) VALUES (true);
    CREATE TABLE inbox_control.baseline_progress(singleton boolean PRIMARY KEY CHECK(singleton), stage text NOT NULL, cursor uuid);
    INSERT INTO inbox_control.baseline_progress(singleton,stage) VALUES (true,'done');
    CREATE TABLE inbox_capture_boundary.generation(singleton boolean PRIMARY KEY CHECK(singleton), generation uuid NOT NULL);
    INSERT INTO inbox_capture_boundary.generation VALUES (true,'10000000-0000-0000-0000-000000000001');
    CREATE TABLE inbox_backfill.jobs(org_id uuid PRIMARY KEY, stream text NOT NULL, claim_token uuid, capture_fingerprint text NOT NULL, completed_at timestamptz);
    CREATE TABLE inbox_backfill.collisions(org_id uuid NOT NULL, conversation_id uuid NOT NULL, generation integer NOT NULL, ack integer NOT NULL, duplicate_thread_ids uuid[], PRIMARY KEY(org_id,conversation_id));
    CREATE OR REPLACE FUNCTION inbox_backfill.fingerprint() RETURNS text LANGUAGE sql STABLE AS $$ SELECT 'fixture-writer-v1' $$;
    CREATE TABLE inbox_parent.work(org_id uuid PRIMARY KEY, generation integer NOT NULL, ack integer NOT NULL, claim_token uuid);
    CREATE TABLE inbox_safety.routes(org_id uuid PRIMARY KEY, generation integer NOT NULL, ack integer NOT NULL, claim_token uuid);
    CREATE TABLE inbox_maintained.rows(org_id uuid NOT NULL, target_kind text NOT NULL, target_id uuid NOT NULL, revision bigint NOT NULL, source_generation bigint NOT NULL, summary jsonb, next_expiry timestamptz, PRIMARY KEY(org_id,target_kind,target_id));
    CREATE TABLE inbox_maintained.queue(org_id uuid NOT NULL, target_kind text NOT NULL, target_id uuid NOT NULL, PRIMARY KEY(org_id,target_kind,target_id));
    CREATE TABLE inbox_message_capture.dirty(org_id uuid NOT NULL, target_kind text NOT NULL, target_id uuid NOT NULL, generation bigint NOT NULL, PRIMARY KEY(org_id,target_kind,target_id));
    CREATE TABLE inbox_bridge.summaries(org_id uuid NOT NULL, target_kind text NOT NULL, target_id uuid NOT NULL, projection_revision bigint NOT NULL, source_generation bigint NOT NULL, name text NOT NULL, context text NOT NULL, preview text NOT NULL, time_label text NOT NULL, outcome_label text NOT NULL, assigned_label text NOT NULL, unread boolean, latest_at timestamptz, visible_active boolean NOT NULL, visible_dismissed boolean NOT NULL, visible_review boolean NOT NULL, visible_unread boolean NOT NULL, PRIMARY KEY(org_id,target_kind,target_id));
    CREATE TRIGGER maintained_queue AFTER INSERT OR UPDATE ON inbox_message_capture.dirty FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER bridge_projection AFTER INSERT OR UPDATE ON inbox_maintained.rows FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TRIGGER bridge_filter_projection AFTER INSERT OR UPDATE ON inbox_maintained.rows FOR EACH ROW EXECUTE FUNCTION public.inbox_test_writer();
    CREATE TABLE inbox_control.marker_audit(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY);
    CREATE OR REPLACE FUNCTION inbox_control.audit_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.backfill_complete IS DISTINCT FROM OLD.backfill_complete OR NEW.reconciliation_complete IS DISTINCT FROM OLD.reconciliation_complete THEN INSERT INTO inbox_control.marker_audit DEFAULT VALUES; END IF; RETURN NEW; END $$;
    CREATE TRIGGER marker_audit AFTER UPDATE ON inbox_control.rollout FOR EACH ROW EXECUTE FUNCTION inbox_control.audit_marker();
  `);
  const org = "10000000-0000-0000-0000-000000000010";
  const emptyOrg = "10000000-0000-0000-0000-000000000011";
  const target = "20000000-0000-0000-0000-000000000020";
  const tombstone = "20000000-0000-0000-0000-000000000021";
  const now = "2026-09-29T12:00:00.000Z";
  const summary = { exists: true, target_kind: "known_conversation", conversation_id: target, contact_name: "Synthetic contact", property_address: "Synthetic address", last_message_preview: "Synthetic preview", last_message_at: now, outreach_dispo: "No outcome", assigned_user_id: null, unread_count: 1, visible_all_hide_noise: true, visible_review: false, visible_unread_hide_noise: true };
  await client.query("INSERT INTO public.organizations VALUES ($1),($2)", [org, emptyOrg]);
  await client.query("INSERT INTO inbox_backfill.jobs VALUES ($1,'done',NULL,'fixture-writer-v1',$2),($3,'done',NULL,'fixture-writer-v1',$2)", [org, now, emptyOrg]);
  await client.query("INSERT INTO inbox_message_capture.dirty VALUES ($1,'known_conversation',$2,4)", [org, target]);
  await client.query("INSERT INTO inbox_maintained.rows VALUES ($1,'known_conversation',$2,2,4,$3,NULL)", [org, target, JSON.stringify(summary)]);
  await client.query("INSERT INTO inbox_bridge.summaries VALUES ($1,'known_conversation',$2,2,4,'Synthetic contact','Synthetic address','Synthetic preview',$3,'No outcome','Unassigned',true,$4,true,false,false,true)", [org, target, now, now]);
  await client.query("INSERT INTO inbox_message_capture.dirty VALUES ($1,'known_conversation',$2,1)", [emptyOrg, tombstone]);
  await client.query("INSERT INTO inbox_maintained.rows VALUES ($1,'known_conversation',$2,1,1,$3,NULL)", [emptyOrg, tombstone, JSON.stringify({ exists: false, target_kind: "known_conversation", conversation_id: tombstone })]);
}

test("R6a local disposable database guard matrix", { skip: !RUN }, async () => {
  const disposable = await createDatabase();
  const directory = await mkdtemp(path.join(os.tmpdir(), "inbox-reconcile-test-"));
  try {
    await fixture(disposable.client);
    // Derive the reviewed fingerprint from the fixture catalog before each run.
    const catalogResult = await collectEvidence(disposable.client, { expectedCatalogFingerprint: "0".repeat(64), sourceWriterAttestation: null });
    assert.equal(catalogResult.status, "blocked");
    assert.equal(catalogResult.checks.catalog_fingerprint_match, false);
    const expectedCatalog = catalogResult.fingerprints.live_catalog;
    const source = {
      capture_generation: "10000000-0000-0000-0000-000000000001",
      bypass_since_install: false,
      covered_tables: [...new Set(SOURCE_WRITERS.map(([table]) => table))],
      catalog_fingerprint: expectedCatalog,
    };
    const attestationPath = path.join(directory, "coverage.json");
    await writeFile(attestationPath, JSON.stringify({ ...source, digest: attestationDigest(source) }));
    const attestedSource = { ...source, digest: attestationDigest(source) };
    const base = { expectedCatalogFingerprint: expectedCatalog, sourceWriterAttestation: attestedSource, attestationPath };

    await disposable.client.query("ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct");
    let coverageResult = await collectEvidence(disposable.client, base);
    assert.equal(coverageResult.checks.source_writer_coverage, false);
    await disposable.client.query("ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct");

    let evidenceText = JSON.stringify((await collectEvidence(disposable.client, base)));
    assert.equal(evidenceText.includes("10000000-0000-0000-0000-000000000010"), false);
    assert.equal(evidenceText.includes("Synthetic"), false);

    let result = await reconcileAndMaybeWrite(disposable.client, base);
    assert.equal(result.status, "ready");
    assert.equal((await disposable.client.query("SELECT count(*)::int AS n FROM inbox_control.marker_audit")).rows[0].n, 0);

    await disposable.client.query("UPDATE inbox_backfill.jobs SET stream='messages',completed_at=NULL WHERE org_id=$1", ["10000000-0000-0000-0000-000000000011"]);
    result = await reconcileAndMaybeWrite(disposable.client, base);
    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.checks.backfill_complete, false);
    assert.equal((await disposable.client.query("SELECT backfill_complete,reconciliation_complete FROM inbox_control.rollout")).rows[0].backfill_complete, false);

    await disposable.client.query("UPDATE inbox_backfill.jobs SET stream='done',completed_at=$1 WHERE org_id=$2", ["2026-09-29T12:00:00.000Z", "10000000-0000-0000-0000-000000000011"]);
    await disposable.client.query("INSERT INTO inbox_backfill.collisions VALUES ($1,$2,2,2,ARRAY['30000000-0000-0000-0000-000000000030'::uuid,'30000000-0000-0000-0000-000000000031'::uuid])", ["10000000-0000-0000-0000-000000000010", "20000000-0000-0000-0000-000000000020"]);
    result = await reconcileAndMaybeWrite(disposable.client, { ...base, writeMarkers: true });
    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.checks.no_unresolved_collisions, false);
    assert.equal((await disposable.client.query("SELECT count(*)::int AS n FROM inbox_control.marker_audit")).rows[0].n, 0);

    await disposable.client.query("DELETE FROM inbox_backfill.collisions");
    await disposable.client.query("UPDATE inbox_bridge.summaries SET preview='wrong projection' WHERE org_id=$1", ["10000000-0000-0000-0000-000000000010"]);
    result = await reconcileAndMaybeWrite(disposable.client, base);
    assert.equal(result.status, "blocked");
    assert.equal(result.evidence.checks.projection_reconciled, false);
    await disposable.client.query("UPDATE inbox_bridge.summaries SET preview='Synthetic preview' WHERE org_id=$1", ["10000000-0000-0000-0000-000000000010"]);
    result = await reconcileAndMaybeWrite(disposable.client, { ...base, writeMarkers: true });
    assert.equal(result.status, "written");
    assert.deepEqual((await disposable.client.query("SELECT backfill_complete,reconciliation_complete,serving_enabled FROM inbox_control.rollout")).rows[0], { backfill_complete: true, reconciliation_complete: true, serving_enabled: false });
    assert.equal((await disposable.client.query("SELECT count(*)::int AS n FROM inbox_control.marker_audit")).rows[0].n, 1);

    result = await reconcileAndMaybeWrite(disposable.client, { ...base, writeMarkers: true });
    assert.equal(result.status, "idempotent");
    assert.equal((await disposable.client.query("SELECT count(*)::int AS n FROM inbox_control.marker_audit")).rows[0].n, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await disposable.dispose();
  }
});

test("attestation digest is stable and does not include a secret-bearing field", () => {
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
