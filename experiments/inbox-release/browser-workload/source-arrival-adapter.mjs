#!/usr/bin/env node

/**
 * Owned synthetic inbound-message source fixture for the release workload.
 *
 * This adapter is intentionally separate from the browser workload. It uses
 * the marked local Supabase service client to insert a new inbound message
 * into an explicitly pre-seeded known conversation, then uses a read-only
 * PostgreSQL connection to observe that exact message id and projection
 * generation. It never infers arrival from an existing browser row.
 */

import { access, readFile, rename, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { measuredRecord, sourceArrivalTiming, WorkloadBlocked } from "./adapter.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXTURE_API_URL = "http://127.0.0.1:54321";
const FIXTURE_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const FIXTURE_CONTAINER_MARKER = "sandra-inbox-release-http-owned-20260917";
const FIXTURE_DATABASE_MARKER = "sandra-inbox-http-owned-synthetic-20260917";
const FIXTURE_DATABASE_PURPOSE = "sandra-inbox-release-http";

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new WorkloadBlocked(`${label} is required`);
  return value.trim();
}

function uuid(value, label) {
  const text = requiredString(value, label);
  if (!UUID.test(text)) throw new WorkloadBlocked(`${label} must be a UUID`);
  return text.toLowerCase();
}

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new WorkloadBlocked(`${label} must be finite and positive`);
  return number;
}

function finiteNonNegative(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new WorkloadBlocked(`${label} must be finite and non-negative`);
  return number;
}

function safeInteger(value, label, { minimum = 0, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new WorkloadBlocked(`${label} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return number;
}

function wallClockMs() {
  return performance.timeOrigin + performance.now();
}

/**
 * Build an open-loop source schedule before any source request is sent.
 * `arrivalRateRps` is the cadence of bursts.  Messages inside a burst are
 * separated by `burstGapMs`; a zero gap is intentional and is represented in
 * the manifest rather than being turned into an infinite measured rate.
 */
export function planSourceMessages({ count, startAtMs, arrivalRateRps, burstSize = 1, burstGapMs = 0, idFactory = randomUUID, maxMessages = Number.MAX_SAFE_INTEGER }) {
  const messageBound = safeInteger(maxMessages, "source message bound", { minimum: 1 });
  const boundedCount = safeInteger(count, "source message count", { minimum: 1, maximum: messageBound });
  const start = finiteNonNegative(startAtMs, "source schedule startAtMs");
  const rate = finitePositive(arrivalRateRps, "source arrival rate");
  const size = safeInteger(burstSize, "source burst size", { minimum: 1, maximum: boundedCount });
  const gap = finiteNonNegative(burstGapMs, "source burst gap");
  if (typeof idFactory !== "function") throw new WorkloadBlocked("source message id factory must be callable");
  const cadenceMs = 1000 / rate;
  const ids = new Set();
  return Array.from({ length: boundedCount }, (_unused, index) => {
    const burstIndex = Math.floor(index / size);
    const positionInBurst = index % size;
    const id = uuid(idFactory(), `source message ${index} id`);
    if (ids.has(id)) throw new WorkloadBlocked(`source message id is duplicated: ${id}`);
    ids.add(id);
    return {
      id,
      index,
      plannedAtMs: start + burstIndex * cadenceMs + positionInBurst * gap,
      status: "planned",
    };
  });
}

function assertFixtureGuard(env) {
  if (env.INBOX_RELEASE_SOURCE_FIXTURE_ENABLED !== "1") throw new WorkloadBlocked("source fixture requires INBOX_RELEASE_SOURCE_FIXTURE_ENABLED=1");
  if (env.INBOX_NO_PROVIDER !== "1") throw new WorkloadBlocked("INBOX_NO_PROVIDER=1 is required");
  if (env.INBOX_RELEASE_TARGET_PROBED !== "true") throw new WorkloadBlocked("independent target probe is required");
  if (env.INBOX_RELEASE_TARGET_CONTAINER_MARKER !== FIXTURE_CONTAINER_MARKER) throw new WorkloadBlocked("source fixture container marker mismatch");
  if (env.INBOX_RELEASE_TARGET_DATABASE_MARKER !== FIXTURE_DATABASE_MARKER) throw new WorkloadBlocked("source fixture database marker mismatch");
  if (env.INBOX_RELEASE_TARGET_DATABASE_PURPOSE !== FIXTURE_DATABASE_PURPOSE) throw new WorkloadBlocked("source fixture database purpose mismatch");
  if ((env.INBOX_RELEASE_PROVIDER_TRAFFIC ?? "false") !== "false") throw new WorkloadBlocked("provider traffic must remain disabled");
  if ((env.INBOX_RELEASE_CUSTOMER_SENDS ?? "false") === "true") throw new WorkloadBlocked("customer sends must remain disabled");
  const apiUrl = requiredString(env.INBOX_RELEASE_FIXTURE_API_URL ?? env.TEST_SUPABASE_URL, "INBOX_RELEASE_FIXTURE_API_URL").replace(/\/$/, "");
  if (apiUrl !== FIXTURE_API_URL) throw new WorkloadBlocked("source fixture API must be the exact owned loopback endpoint");
  const databaseUrl = requiredString(env.INBOX_RELEASE_DATABASE_URL ?? env.INBOX_PROJECTION_DATABASE_URL, "INBOX_RELEASE_DATABASE_URL");
  if (databaseUrl !== FIXTURE_DATABASE_URL) throw new WorkloadBlocked("source fixture database must be the exact owned loopback endpoint");
  const serviceKey = requiredString(env.INBOX_RELEASE_SERVICE_ROLE_KEY ?? env.HTTP_SERVICE_ROLE_KEY, "INBOX_RELEASE_SERVICE_ROLE_KEY");
  const profile = requiredString(env.INBOX_STRESS_PROFILE, "INBOX_STRESS_PROFILE");
  if (profile !== "current" && profile !== "three_x") throw new WorkloadBlocked(`unsupported stress profile: ${profile}`);
  return { apiUrl, databaseUrl, serviceKey, profile };
}

export function readSourceScenario(decoded) {
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new WorkloadBlocked("source scenario must be an object");
  return Object.freeze({
    orgId: uuid(decoded.orgId ?? decoded.org_id, "source scenario.orgId"),
    conversationId: uuid(decoded.conversationId ?? decoded.conversation_id, "source scenario.conversationId"),
    contactId: uuid(decoded.contactId ?? decoded.contact_id, "source scenario.contactId"),
    propertyId: uuid(decoded.propertyId ?? decoded.property_id, "source scenario.propertyId"),
    fromAddress: requiredString(decoded.fromAddress ?? decoded.from_address, "source scenario.fromAddress"),
    toAddress: requiredString(decoded.toAddress ?? decoded.to_address, "source scenario.toAddress"),
  });
}

export function projectionObservationReady(row, messageId, scenario) {
  if (!row || typeof row !== "object") return false;
  return row.org_id === scenario.orgId
    && row.target_kind === "known_conversation"
    && row.target_id === scenario.conversationId
    && row.last_message_id === messageId
    && Number.isSafeInteger(Number(row.dirty_generation))
    && Number(row.dirty_generation) > 0
    && Number(row.source_generation) === Number(row.dirty_generation)
    && Number(row.bridge_source_generation) === Number(row.source_generation)
    && Number(row.bridge_revision) === Number(row.revision)
    && Number(row.filter_revision) === Number(row.revision)
    && row.exists === true;
}

/**
 * Coalesced projection workers may legitimately publish a later
 * last_message_id before a poll observes an intermediate source row. The
 * The source capture dirty.generation is the durable per-target boundary:
 * once the target's coherent source_generation reaches the post-commit
 * capture generation, the projection has caught up through the source write
 * even if its summary now names a later message. The canonical
 * messages.inbox_inbound_revision is retained as identity evidence only; it
 * is allocated by a different per-conversation counter and cannot be used as
 * a projection generation cutoff.
 */
export function projectionGenerationReady(row, sourceCaptureGeneration, scenario) {
  if (!row || typeof row !== "object") return false;
  const captureGeneration = Number(sourceCaptureGeneration);
  return row.org_id === scenario.orgId
    && row.target_kind === "known_conversation"
    && row.target_id === scenario.conversationId
    && Number.isSafeInteger(captureGeneration)
    && captureGeneration > 0
    && Number.isSafeInteger(Number(row.dirty_generation))
    && Number(row.dirty_generation) > 0
    && Number(row.source_generation) >= captureGeneration
    // A later source capture may advance dirty.generation while this
    // target's projection is already coherent through the captured write.
    // Requiring equality here turns an open-loop arrival workload into a
    // wait-for-quiescence loop.  Keep the cutoff and component generations
    // authoritative, while allowing dirty to be ahead of the observed
    // projection generation.
    && Number(row.dirty_generation) >= Number(row.source_generation)
    && Number(row.bridge_source_generation) === Number(row.source_generation)
    && Number(row.bridge_revision) === Number(row.revision)
    && Number(row.filter_revision) === Number(row.revision)
    && row.exists === true;
}

function sourceMessagePayload(scenario, messageId, arrivalAtMs, runId, index) {
  return {
    id: messageId,
    org_id: scenario.orgId,
    conversation_id: scenario.conversationId,
    contact_id: scenario.contactId,
    property_id: scenario.propertyId,
    channel: "sms",
    direction: "inbound",
    status: "received",
    from_address: scenario.fromAddress,
    to_address: scenario.toAddress,
    body: `Owned release source fixture ${runId} message ${index + 1}`,
    created_at: new Date(arrivalAtMs).toISOString(),
  };
}

async function readJsonFile(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new WorkloadBlocked(`cannot read ${label}: ${path}`);
  }
}

async function verifyPreseededScenario(admin, scenario) {
  const { data: contact, error: contactError } = await admin
    .from("contacts")
    .select("id,org_id,phone_1")
    .eq("id", scenario.contactId)
    .eq("org_id", scenario.orgId)
    .maybeSingle();
  if (contactError || !contact || contact.phone_1 !== scenario.fromAddress) throw new WorkloadBlocked("source scenario contact identity is not pre-seeded exactly");

  const { data: property, error: propertyError } = await admin
    .from("properties")
    .select("id,org_id,homeowner_contact_id")
    .eq("id", scenario.propertyId)
    .eq("org_id", scenario.orgId)
    .maybeSingle();
  if (propertyError || !property || property.homeowner_contact_id !== scenario.contactId) throw new WorkloadBlocked("source scenario property identity is not pre-seeded exactly");

  const { data: existingMessages, error: messageError } = await admin
    .from("messages")
    .select("id")
    .eq("org_id", scenario.orgId)
    .eq("conversation_id", scenario.conversationId)
    .limit(1);
  if (messageError || !existingMessages?.length) throw new WorkloadBlocked("source scenario conversation has no pre-seeded canonical message");
}

async function databaseIdentity(client) {
  const result = await client.query("SELECT current_database() AS database, marker FROM install_fixture.identity LIMIT 1");
  const row = result.rows[0];
  if (!row || row.database !== "postgres" || row.marker !== FIXTURE_DATABASE_MARKER) {
    throw new WorkloadBlocked("source fixture database identity mismatch");
  }
}

const PROJECTION_STATE_SQL = `
  SELECT
    m.org_id, m.target_kind, m.target_id,
    m.revision, m.source_generation,
    (m.summary->>'exists')::boolean AS exists,
    m.summary->>'last_message_id' AS last_message_id,
    d.generation AS dirty_generation,
    s.source_generation AS bridge_source_generation,
    s.projection_revision AS bridge_revision,
    f.revision AS filter_revision
  FROM inbox_maintained.rows m
  JOIN inbox_message_capture.dirty d
    ON d.org_id=m.org_id AND d.target_kind=m.target_kind AND d.target_id=m.target_id
  JOIN inbox_bridge.summaries s
    ON s.org_id=m.org_id AND s.target_kind=m.target_kind AND s.target_id=m.target_id
  JOIN inbox_bridge.filter_rows f
    ON f.org_id=m.org_id AND f.target_kind=m.target_kind AND f.target_id=m.target_id
  WHERE m.org_id=$1::uuid
    AND m.target_kind='known_conversation'
    AND m.target_id=$2::uuid
  LIMIT 1`;

const SOURCE_CAPTURE_CUTOFF_SQL = `
  SELECT
    m.id,
    m.inbox_inbound_revision AS inbound_revision,
    d.generation AS source_capture_generation
    FROM public.messages m
    JOIN inbox_message_capture.dirty d
      ON d.org_id=m.org_id
     AND d.target_kind='known_conversation'
     AND d.target_id=m.conversation_id
   WHERE m.id=$1::uuid
     AND m.org_id=$2::uuid
     AND m.conversation_id=$3::uuid
     AND m.channel='sms'
     AND m.direction='inbound'`;

async function readSourceCaptureCutoff(client, scenario, messageId) {
  // One post-commit query binds the exact source id to the target's capture
  // generation. The latter, not inbox_inbound_revision, is the projection
  // counter used by the readiness check.
  const result = await client.query(SOURCE_CAPTURE_CUTOFF_SQL, [messageId, scenario.orgId, scenario.conversationId]);
  const row = result.rows[0];
  const inboundRevision = Number(row?.inbound_revision);
  const sourceCaptureGeneration = Number(row?.source_capture_generation);
  if (!row || row.id !== messageId || !Number.isSafeInteger(inboundRevision) || inboundRevision <= 0) {
    throw new WorkloadBlocked(`source message ${messageId} has no positive server-owned inbound revision identity`);
  }
  if (!Number.isSafeInteger(sourceCaptureGeneration) || sourceCaptureGeneration <= 0) {
    throw new WorkloadBlocked(`source message ${messageId} has no positive post-commit capture generation`);
  }
  return { inboundRevision, sourceCaptureGeneration };
}

async function waitForProjection(client, scenario, sourceCaptureGeneration, timeoutMs, intervalMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const result = await client.query(PROJECTION_STATE_SQL, [scenario.orgId, scenario.conversationId]);
    const row = result.rows[0];
    if (projectionGenerationReady(row, sourceCaptureGeneration, scenario)) return row;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new WorkloadBlocked(`source capture generation ${sourceCaptureGeneration} did not reach a coherent projected generation before the bound`);
}

async function writeManifest(path, manifestText) {
  if (!isAbsolute(path)) throw new WorkloadBlocked("INBOX_RELEASE_SOURCE_ID_MANIFEST must be an absolute path");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, manifestText, { flag: "wx" });
  await rename(temporary, path);
}

function createManifestWriter(path, manifest) {
  let queue = Promise.resolve();
  return async function persistManifest() {
    const snapshot = `${JSON.stringify(manifest, null, 2)}\n`;
    const write = queue.then(() => writeManifest(path, snapshot));
    // Keep later snapshots writable after an individual write error while
    // still returning the failure to the caller that requested it.
    queue = write.catch(() => {});
    return write;
  };
}

async function sleepUntil(timestampMs) {
  while (wallClockMs() < timestampMs) await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(50, timestampMs - wallClockMs())));
}

export async function main(env = process.env) {
  const { apiUrl, databaseUrl, serviceKey, profile } = assertFixtureGuard(env);
  const scenarioPath = resolve(requiredString(env.INBOX_RELEASE_SOURCE_SCENARIO, "INBOX_RELEASE_SOURCE_SCENARIO"));
  const manifestPath = requiredString(env.INBOX_RELEASE_SOURCE_ID_MANIFEST, "INBOX_RELEASE_SOURCE_ID_MANIFEST");
  if (!isAbsolute(manifestPath)) throw new WorkloadBlocked("INBOX_RELEASE_SOURCE_ID_MANIFEST must be an absolute path");
  try {
    await access(manifestPath, fsConstants.F_OK);
    throw new WorkloadBlocked(`source id manifest already exists: ${manifestPath}`);
  } catch (error) {
    if (error instanceof WorkloadBlocked) throw error;
    if (error?.code !== "ENOENT") throw new WorkloadBlocked(`cannot reserve source id manifest: ${manifestPath}`);
  }
  try {
    await access(scenarioPath, fsConstants.R_OK);
  } catch {
    throw new WorkloadBlocked(`source scenario is unreadable: ${scenarioPath}`);
  }
  const scenario = readSourceScenario(await readJsonFile(scenarioPath, "source scenario"));
  const maxMessages = safeInteger(env.INBOX_RELEASE_SOURCE_MAX_MESSAGES, "INBOX_RELEASE_SOURCE_MAX_MESSAGES", { minimum: 1 });
  const count = safeInteger(env.INBOX_RELEASE_SOURCE_MESSAGE_COUNT, "INBOX_RELEASE_SOURCE_MESSAGE_COUNT", { minimum: 1, maximum: maxMessages });
  const arrivalRateRps = finitePositive(env.INBOX_RELEASE_SOURCE_ARRIVAL_RATE_RPS ?? env.INBOX_STRESS_ARRIVAL_RATE_RPS, "INBOX_RELEASE_SOURCE_ARRIVAL_RATE_RPS");
  const burstSize = safeInteger(env.INBOX_RELEASE_SOURCE_BURST_SIZE ?? 1, "INBOX_RELEASE_SOURCE_BURST_SIZE", { minimum: 1, maximum: count });
  const burstGapMs = finiteNonNegative(env.INBOX_RELEASE_SOURCE_BURST_GAP_MS ?? 0, "INBOX_RELEASE_SOURCE_BURST_GAP_MS");
  const startDelayMs = finiteNonNegative(env.INBOX_RELEASE_SOURCE_START_DELAY_MS ?? 100, "INBOX_RELEASE_SOURCE_START_DELAY_MS");
  const timeoutMs = finitePositive(env.INBOX_RELEASE_SOURCE_PROJECTION_TIMEOUT_MS ?? 30_000, "INBOX_RELEASE_SOURCE_PROJECTION_TIMEOUT_MS");
  const intervalMs = finitePositive(env.INBOX_RELEASE_SOURCE_PROJECTION_INTERVAL_MS ?? 250, "INBOX_RELEASE_SOURCE_PROJECTION_INTERVAL_MS");
  const runId = randomUUID();
  const startAtMs = wallClockMs() + startDelayMs;
  const plannedMessages = planSourceMessages({ count, maxMessages, startAtMs, arrivalRateRps, burstSize, burstGapMs });
  const manifest = {
    schema_version: 1,
    owner: "release-infra",
    fixture_api: apiUrl,
    fixture_database: "postgres",
    database_marker: FIXTURE_DATABASE_MARKER,
    database_purpose: FIXTURE_DATABASE_PURPOSE,
    source_scenario: scenario,
    run_id: runId,
    schedule: {
      message_count: count,
      message_bound: maxMessages,
      arrival_rate_rps: arrivalRateRps,
      burst_size: burstSize,
      burst_gap_ms: burstGapMs,
      cadence_ms: 1000 / arrivalRateRps,
      start_at_ms: startAtMs,
      start_delay_ms: startDelayMs,
    },
    status: "planned",
    messages: plannedMessages,
  };
  const persistManifest = createManifestWriter(manifestPath, manifest);

  const [{ createClient }, { Client }] = await Promise.all([
    import("@supabase/supabase-js"),
    import("pg"),
  ]);
  const admin = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const database = new Client({ connectionString: databaseUrl, connectionTimeoutMillis: 5_000, statement_timeout: 3_000, ssl: false });
  await database.connect();
  try {
    await databaseIdentity(database);
    await verifyPreseededScenario(admin, scenario);
    // This is the durability boundary: every planned id is on disk before
    // the first network request.  A crash or uncertain response therefore
    // leaves an operator-owned reconciliation list instead of an untracked
    // message that could be retried and double-counted.
    await persistManifest();

    async function insertAndObserve(record) {
      await sleepUntil(record.plannedAtMs);
      record.status = "inserting";
      record.request_started_at_ms = wallClockMs();
      await persistManifest();
      const arrivalAtMs = record.request_started_at_ms;
      const payload = sourceMessagePayload(scenario, record.id, arrivalAtMs, runId, record.index);
      let data;
      try {
        const response = await admin.from("messages").insert(payload).select("id,created_at").single();
        data = response.data;
        if (response.error || !data || data.id !== record.id) {
          throw new WorkloadBlocked(`source fixture message insert failed: ${response.error?.message ?? "missing inserted id"}`);
        }
      } catch (error) {
        record.status = "uncertain";
        record.uncertain_at_ms = wallClockMs();
        record.error = error instanceof Error ? error.message : String(error);
        await persistManifest();
        throw error instanceof WorkloadBlocked ? error : new WorkloadBlocked(`source fixture message insert response was uncertain: ${record.error}`);
      }
      record.status = "accepted";
      record.arrivalAtMs = arrivalAtMs;
      record.acceptedAtMs = wallClockMs();
      record.createdAt = data.created_at;
      const sourceCapture = await readSourceCaptureCutoff(database, scenario, record.id);
      // The inbound revision proves this exact canonical message was stamped;
      // sourceCaptureGeneration is the counter used for projection readiness.
      record.inboundRevision = sourceCapture.inboundRevision;
      record.sourceCaptureGeneration = sourceCapture.sourceCaptureGeneration;
      await persistManifest();

      // Observe each accepted id immediately and independently.  The source
      // schedule never waits for projection completion; if projection jumps
      // past an id, this exact-id check fails closed instead of reporting a
      // later row as that message's ingestion observation.
      record.status = "observing";
      record.observation_started_at_ms = wallClockMs();
      await persistManifest();
      let projected;
      try {
        projected = await waitForProjection(database, scenario, record.sourceCaptureGeneration, timeoutMs, intervalMs);
      } catch (error) {
        record.status = "unobserved";
        record.unobserved_at_ms = wallClockMs();
        record.error = error instanceof Error ? error.message : String(error);
        await persistManifest();
        throw error;
      }
      const observedAtMs = wallClockMs();
      record.status = "observed";
      record.observedAtMs = observedAtMs;
      record.projectedVersion = Number(projected.source_generation);
      await persistManifest();
      process.stdout.write(`${JSON.stringify(sourceArrivalTiming(profile, {
        targetId: scenario.conversationId,
        sourceMessageId: record.id,
        inboundRevision: record.inboundRevision,
        sourceCaptureGeneration: record.sourceCaptureGeneration,
        arrivalAtMs,
        observedAtMs,
        projectedVersion: record.projectedVersion,
      }))}\n`);
    }

    // All tasks are scheduled together.  Projection latency can no longer
    // throttle the next source arrival, which makes this an open-loop source
    // workload rather than the old closed-loop insert-then-wait smoke test.
    const results = await Promise.allSettled(manifest.messages.map((record) => insertAndObserve(record)));
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;

    const arrivals = manifest.messages.filter((record) => record.status === "observed").sort((left, right) => left.arrivalAtMs - right.arrivalAtMs);
    for (let index = 1; index < arrivals.length; index += 1) {
      const interval = arrivals[index].arrivalAtMs - arrivals[index - 1].arrivalAtMs;
      // A burst can legitimately have a zero interval.  It is retained in
      // the schedule/manifest but is excluded from the finite measured-rate
      // samples because its instantaneous rate is undefined.
      if (interval > 0) {
        process.stdout.write(`${JSON.stringify(measuredRecord("metric", profile, {
          name: "arrival_rate_rps",
          value: 1000 / interval,
          sample: { basis: "source_fixture_arrival_intervals", sourceMessageId: arrivals[index].id },
        }))}\n`);
      }
    }
    manifest.status = "observed";
    manifest.completed_at_ms = wallClockMs();
    await persistManifest();
  } catch (error) {
    manifest.status = "blocked";
    manifest.error = error instanceof Error ? error.message : String(error);
    try {
      await persistManifest();
    } catch {
      // Preserve the original failure; a manifest write failure is reported
      // by the original caller on the next controlled run.
    }
    throw error;
  } finally {
    await database.end();
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`BLOCKED: ${message}\n`);
    process.exitCode = 2;
  });
}
