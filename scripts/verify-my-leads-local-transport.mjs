/**
 * Rehearse the local-only Sandra <- Jitter seller-call transport.
 *
 * This script deliberately uses the existing isolated acceptance runtime. It
 * does not reset the database, create users, call a provider, or contact a
 * non-loopback host. The one credential it creates is removed in finally;
 * the resulting acquisition attempt remains as acceptance evidence.
 */

import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";

const APP_URL = "http://127.0.0.1:58700";
const SUPABASE_API_URL = "http://127.0.0.1:58321";
const RUNTIME_FILE = "/tmp/sandra-my-leads-acceptance-20260911/runtime.json";

const FIXTURE = Object.freeze({
  orgId: "00000000-0000-0000-0000-000000000bbb",
  propertyId: "20000000-0000-4000-8000-000000000001",
  repUserId: "10000000-0000-4000-8000-000000000003",
});

const RECEIVER_PATH = "/api/internal/jitter/my-leads/call-started";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readLocalRuntime() {
  let runtime;
  try {
    runtime = JSON.parse(readFileSync(RUNTIME_FILE, "utf8"));
  } catch {
    throw new Error("local runtime file unavailable");
  }

  // Do not print this object: it contains local service keys.
  assert.equal(runtime.API_URL, SUPABASE_API_URL, "unexpected local Supabase API");
  assert.equal(typeof runtime.DB_URL, "string", "runtime DB URL missing");
  assert.equal(typeof runtime.SERVICE_ROLE_KEY, "string", "runtime service key missing");
  assert.notEqual(runtime.SERVICE_ROLE_KEY.length, 0, "runtime service key empty");

  let databaseUrl;
  try {
    databaseUrl = new URL(runtime.DB_URL);
  } catch {
    throw new Error("runtime DB URL is invalid");
  }
  assert.equal(databaseUrl.protocol, "postgresql:", "unexpected local DB protocol");
  assert.equal(databaseUrl.hostname, "127.0.0.1", "non-loopback DB host refused");
  assert.equal(databaseUrl.port, "58322", "unexpected local DB port");

  for (const url of [new URL(runtime.API_URL), new URL(APP_URL)]) {
    assert.equal(url.protocol, "http:", "HTTPS/provider URL is not allowed");
    assert.equal(url.hostname, "127.0.0.1", "non-loopback HTTP host refused");
  }
  return runtime;
}

function signBody(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

async function postReceiver({ body, secret, signature = signBody(secret, body) }) {
  const url = new URL(RECEIVER_PATH, APP_URL);
  assert.equal(url.origin, APP_URL, "receiver URL escaped the local app");
  return fetch(url, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
    headers: {
      authorization: `Bearer ${secret}`,
      "content-type": "application/json",
      "x-sandra-signature": signature,
    },
    body,
  });
}

async function readJson(response) {
  // Never include response text in an error or receipt. Local route errors can
  // contain implementation details, and the transport proof only needs status
  // plus the small fields asserted by the caller.
  try {
    return await response.json();
  } catch {
    throw new Error("receiver returned non-JSON");
  }
}

function assertResponseStatus(response, expected, label) {
  assert.equal(response.status, expected, `${label}: unexpected status`);
}

async function main() {
  const runtime = readLocalRuntime();
  const db = new pg.Client({ connectionString: runtime.DB_URL });
  let consumerId = null;
  let connected = false;
  let step = "connect local database";

  const consumerSecret = randomBytes(32).toString("hex");
  const consumerSecretHash = sha256(consumerSecret);
  const consumerName = `my-leads-local-transport-${process.pid}-${randomUUID()}`;
  const sandraCallToken = randomUUID();
  const sandraCallTokenHash = sha256(sandraCallToken.toLowerCase());
  const unboundCallToken = randomUUID();

  try {
    await db.connect();
    connected = true;

    step = "verify four existing fixture identities";
    const identities = await db.query(
      `select id::text
       from auth.users
       where id = any($1::uuid[])
       order by id`,
      [[
        "10000000-0000-4000-8000-000000000002",
        FIXTURE.repUserId,
        "10000000-0000-4000-8000-000000000013",
        "10000000-0000-4000-8000-000000000014",
      ]],
    );
    assert.equal(identities.rowCount, 4, "expected the four existing fixture identities");
    const membership = await db.query(
      `select 1
       from public.memberships
       where org_id = $1 and user_id = $2 and role = 'member'
         and access_status = 'active'
       limit 1`,
      [FIXTURE.orgId, FIXTURE.repUserId],
    );
    assert.equal(membership.rowCount, 1, "fixture rep membership missing");

    step = "seed owned local webhook consumer";
    const consumer = await db.query(
      `insert into public.webhook_consumers
         (org_id, name, secret_hash, consumer_type, enabled, revoked_at)
       values ($1, $2, $3, 'jitter_writeback', true, null)
       returning id::text`,
      [FIXTURE.orgId, consumerName, consumerSecretHash],
    );
    consumerId = consumer.rows[0]?.id ?? null;
    assert.match(consumerId ?? "", /^[0-9a-f-]{36}$/i, "consumer row was not created");

    step = "bind acquisition context through service role";
    let binding;
    try {
      await db.query("set role service_role");
      const result = await db.query(
        `select public.fn_bind_acquisition_call_context($1, $2, $3, $4) as result`,
        [FIXTURE.orgId, FIXTURE.propertyId, FIXTURE.repUserId, sandraCallTokenHash],
      );
      binding = result.rows[0]?.result;
    } finally {
      await db.query("reset role");
    }
    assert.equal(binding?.tracked, true, "fixture acquisition tracking is disabled");
    assert.equal(binding?.orgId, FIXTURE.orgId, "binding org mismatch");
    assert.equal(binding?.propertyId, FIXTURE.propertyId, "binding property mismatch");
    assert.equal(binding?.actorUserId, FIXTURE.repUserId, "binding actor mismatch");
    assert.match(binding?.assignmentEpisodeId ?? "", /^[0-9a-f-]{36}$/i, "binding episode missing");

    const baseEvent = {
      eventId: randomUUID(),
      eventVersion: 1,
      orgId: FIXTURE.orgId,
      propertyId: FIXTURE.propertyId,
      actorUserId: FIXTURE.repUserId,
      assignmentEpisodeId: binding.assignmentEpisodeId,
      sandraCallToken,
      jitterCallId: `jitter-local-${randomUUID()}`,
      sellerProviderCallId: `seller-local-${randomUUID()}`,
      occurredAt: new Date(Date.now() - 1000).toISOString(),
      evidence: "seller_call_create_succeeded",
    };

    step = "reject bad signature before evidence write";
    const validBody = JSON.stringify(baseEvent);
    const badSignature = await postReceiver({
      body: validBody,
      secret: consumerSecret,
      signature: "sha256=" + "0".repeat(64),
    });
    assertResponseStatus(badSignature, 401, "bad signature");

    step = "reject malformed seller evidence";
    const malformedBody = JSON.stringify({ ...baseEvent, evidence: "operator_connected" });
    const malformed = await postReceiver({
      body: malformedBody,
      secret: consumerSecret,
      signature: signBody(consumerSecret, malformedBody),
    });
    assertResponseStatus(malformed, 400, "malformed evidence");

    step = "reject seller evidence without a bound context";
    const unboundEvent = { ...baseEvent, eventId: randomUUID(), sandraCallToken: unboundCallToken };
    const unboundBody = JSON.stringify(unboundEvent);
    const unbound = await postReceiver({
      body: unboundBody,
      secret: consumerSecret,
      signature: signBody(consumerSecret, unboundBody),
    });
    assertResponseStatus(unbound, 409, "unbound evidence");

    step = "record valid seller-call evidence";
    const first = await postReceiver({ body: validBody, secret: consumerSecret });
    assertResponseStatus(first, 200, "valid evidence");
    const firstResult = await readJson(first);
    assert.equal(firstResult.ok, true, "valid evidence did not return ok");
    assert.equal(firstResult.duplicate, false, "first evidence was incorrectly marked duplicate");

    step = "replay valid seller-call evidence";
    const duplicate = await postReceiver({ body: validBody, secret: consumerSecret });
    assertResponseStatus(duplicate, 200, "duplicate evidence");
    const duplicateResult = await readJson(duplicate);
    assert.equal(duplicateResult.ok, true, "duplicate evidence did not return ok");
    assert.equal(duplicateResult.duplicate, true, "duplicate evidence was not deduplicated");

    step = "verify one attempt and original call clock";
    const evidence = await db.query(
      `select
         (select count(*)::int
            from public.acquisition_attempts
           where org_id = $1 and property_id = $2 and source = 'sandra'
             and provider_attempt_key = $3) as attempt_count,
         (select count(*)::int
            from public.acquisition_assignment_episodes
           where id = $5::uuid and org_id = $1 and property_id = $2
             and first_call_started_at is not null
             and first_call_actor_user_id = $4) as clock_count`,
      [FIXTURE.orgId, FIXTURE.propertyId, sandraCallTokenHash, FIXTURE.repUserId, binding.assignmentEpisodeId],
    );
    assert.deepEqual(evidence.rows[0], { attempt_count: 1, clock_count: 1 });
  } catch (error) {
    error.transportStep = step;
    throw error;
  } finally {
    if (consumerId) {
      step = "remove owned local webhook consumer";
      await db.query(
        `delete from public.webhook_consumers
         where id = $1::uuid and name = $2 and secret_hash = $3`,
        [consumerId, consumerName, consumerSecretHash],
      );
      const remaining = await db.query(
        "select count(*)::int as count from public.webhook_consumers where id = $1::uuid",
        [consumerId],
      );
      assert.equal(remaining.rows[0]?.count, 0, "owned local consumer cleanup failed");
    }
    if (connected) await db.end();
  }
}

try {
  await main();
  console.log("PASS local transport: signature/setup rejection, seller start, duplicate, one attempt, and one call clock");
} catch (error) {
  const step = error?.transportStep ?? "local transport rehearsal";
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  console.error(`FAIL ${step}${code}`);
  process.exitCode = 1;
}
