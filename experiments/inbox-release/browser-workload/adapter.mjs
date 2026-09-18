#!/usr/bin/env node

/**
 * Browser workload adapter for the owned release HTTP fixture.
 *
 * The stress runner supplies measured current/three-times dimensions and owns
 * the target identity checks. This adapter adds only the inputs that the
 * runner cannot infer: a loopback app URL, one checked-in storage state per
 * measured operator/tenant slot, pre-seeded conversation ids, a bounded work
 * count, and a read-only database DSN. Every JSONL record below is emitted
 * after an actual browser observation. Missing inputs fail closed on stderr;
 * no placeholder timings, queue values, or system metrics are emitted.
 */

import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const REQUIRED_PROFILE_KEYS = ["arrival_rate_rps", "concurrency", "tenant_count", "history_skew"];

export class WorkloadBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = "WorkloadBlocked";
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new WorkloadBlocked(`${label} is required`);
  return value.trim();
}

function positiveNumber(value, label) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new WorkloadBlocked(`${label} must be a finite positive number`);
  return number;
}

function positiveInteger(value, label) {
  const number = positiveNumber(value, label);
  if (!Number.isSafeInteger(number)) throw new WorkloadBlocked(`${label} must be a safe integer`);
  return number;
}

function uuid(value, label) {
  const text = requiredString(value, label);
  if (!UUID.test(text)) throw new WorkloadBlocked(`${label} must be a UUID`);
  return text.toLowerCase();
}

function loopbackUrl(value, label) {
  let url;
  try {
    url = new URL(requiredString(value, label));
  } catch {
    throw new WorkloadBlocked(`${label} must be an absolute loopback URL`);
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) throw new WorkloadBlocked(`${label} must use HTTP on loopback`);
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function readProfile(env) {
  const profile = requiredString(env.INBOX_STRESS_PROFILE, "INBOX_STRESS_PROFILE");
  if (profile !== "current" && profile !== "three_x") throw new WorkloadBlocked(`unsupported stress profile: ${profile}`);
  const dimensions = Object.fromEntries(REQUIRED_PROFILE_KEYS.map((key) => [key, positiveNumber(env[`INBOX_STRESS_${key.toUpperCase()}`], `INBOX_STRESS_${key.toUpperCase()}`)]));
  dimensions.concurrency = positiveInteger(dimensions.concurrency, "INBOX_STRESS_CONCURRENCY");
  dimensions.tenant_count = positiveInteger(dimensions.tenant_count, "INBOX_STRESS_TENANT_COUNT");
  return { name: profile, dimensions };
}

function assertRunnerContext(env) {
  if (env.INBOX_NO_PROVIDER !== "1") throw new WorkloadBlocked("INBOX_NO_PROVIDER=1 is required");
  if (env.INBOX_RELEASE_TARGET_PROBED !== "true") throw new WorkloadBlocked("independent target probe is required");
  requiredString(env.INBOX_RELEASE_TARGET_CONTAINER_MARKER, "INBOX_RELEASE_TARGET_CONTAINER_MARKER");
  requiredString(env.INBOX_RELEASE_TARGET_DATABASE_MARKER, "INBOX_RELEASE_TARGET_DATABASE_MARKER");
  if ((env.INBOX_RELEASE_PROVIDER_TRAFFIC ?? "false") !== "false") throw new WorkloadBlocked("provider traffic must remain disabled");
  if (env.INBOX_RELEASE_CUSTOMER_SENDS === "true") throw new WorkloadBlocked("customer sends must remain disabled");
  // INBOX_NO_PROVIDER only disables the normal provider seam. The launch
  // packet must separately prove that the local provider double is installed.
  if (env.INBOX_RELEASE_PROVIDER_DOUBLE_VERIFIED !== "true") throw new WorkloadBlocked("provider-double verification is required");
}

function scenarioEntries(value) {
  const entries = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray(value.scenarios) ? value.scenarios : null;
  if (!entries || entries.length === 0) throw new WorkloadBlocked("scenario file must contain a non-empty scenarios array");
  return entries.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new WorkloadBlocked(`scenario ${index} must be an object`);
    const tenantId = requiredString(raw.tenantId ?? raw.tenant_id, `scenario ${index}.tenantId`);
    const operatorId = uuid(raw.operatorId ?? raw.operator_id ?? raw.userId ?? raw.user_id, `scenario ${index}.operatorId`);
    const orgId = uuid(raw.orgId ?? raw.org_id, `scenario ${index}.orgId`);
    const storageState = requiredString(raw.storageState ?? raw.storage_state, `scenario ${index}.storageState`);
    const assigneeId = uuid(raw.assigneeId ?? raw.assignee_id, `scenario ${index}.assigneeId`);
    const rawConversationIds = raw.conversationIds ?? raw.conversation_ids ?? raw.targetIds ?? raw.target_ids;
    if (!Array.isArray(rawConversationIds) || rawConversationIds.length === 0) throw new WorkloadBlocked(`scenario ${index}.conversationIds must be non-empty`);
    const conversationIds = rawConversationIds.map((id, targetIndex) => uuid(id, `scenario ${index}.conversationIds[${targetIndex}]`));
    if (new Set(conversationIds).size !== conversationIds.length) throw new WorkloadBlocked(`scenario ${index}.conversationIds contains duplicates`);
    const appUrl = raw.appUrl ?? raw.app_url;
    return Object.freeze({
      tenantId,
      operatorId,
      orgId,
      storageState: isAbsolute(storageState) ? storageState : resolve(process.cwd(), storageState),
      assigneeId,
      conversationIds,
      appUrl: appUrl === undefined ? undefined : loopbackUrl(appUrl, `scenario ${index}.appUrl`),
      replyTemplate: typeof raw.replyTemplate === "string" && raw.replyTemplate.trim() ? raw.replyTemplate.trim() : "Hi {{first_name | there}}.",
      outcome: typeof raw.outcome === "string" && raw.outcome.trim() ? raw.outcome.trim() : "nurture",
    });
  });
}

export function planWork({ scenarios, cycles, concurrency, tenantCount }) {
  if (!Array.isArray(scenarios) || scenarios.length < concurrency) {
    throw new WorkloadBlocked(`scenario mapping must provide at least one operator state per measured concurrency slot (need ${concurrency})`);
  }
  if (new Set(scenarios.map((scenario) => scenario.operatorId)).size !== scenarios.length) throw new WorkloadBlocked("operator ids must be unique even when operators share an org");
  if (new Set(scenarios.map((scenario) => scenario.storageState)).size !== scenarios.length) throw new WorkloadBlocked("one storage state cannot represent multiple measured tenants/operators");
  if (new Set(scenarios.map((scenario) => scenario.orgId)).size !== tenantCount) throw new WorkloadBlocked(`scenario mapping must exercise exactly ${tenantCount} measured org tenants`);
  if (cycles < scenarios.length) throw new WorkloadBlocked(`work cycles must exercise every measured concurrency slot (need ${scenarios.length})`);
  const jobs = [];
  const targets = new Set();
  for (let index = 0; index < cycles; index += 1) {
    const scenario = scenarios[index % scenarios.length];
    const targetIndex = Math.floor(index / scenarios.length);
    const conversationId = scenario.conversationIds[targetIndex];
    if (!conversationId) throw new WorkloadBlocked(`scenario ${scenario.tenantId} has no unique pre-seeded conversation for cycle ${index + 1}`);
    const target = `${scenario.orgId}:${conversationId}`;
    if (targets.has(target)) throw new WorkloadBlocked(`conversation ${conversationId} is scheduled more than once`);
    targets.add(target);
    jobs.push({ index, scenario, conversationId });
  }
  if (new Set(jobs.map((job) => job.scenario.orgId)).size !== tenantCount) throw new WorkloadBlocked(`planned cycles did not exercise exactly ${tenantCount} measured org tenants`);
  return jobs;
}

export async function loadRuntimeInput(env = process.env) {
  assertRunnerContext(env);
  const profile = readProfile(env);
  const appUrl = loopbackUrl(env.INBOX_RELEASE_APP_URL ?? env.INBOX_STRESS_APP_URL, "INBOX_RELEASE_APP_URL");
  const databaseUrl = requiredString(env.INBOX_RELEASE_DATABASE_URL ?? env.INBOX_STRESS_DATABASE_URL, "INBOX_RELEASE_DATABASE_URL");
  let database;
  try {
    database = new URL(databaseUrl);
  } catch {
    throw new WorkloadBlocked("INBOX_RELEASE_DATABASE_URL must be a PostgreSQL URL");
  }
  if (database.protocol !== "postgres:" && database.protocol !== "postgresql:") throw new WorkloadBlocked("INBOX_RELEASE_DATABASE_URL must use PostgreSQL");
  if (!LOOPBACK.has(database.hostname)) throw new WorkloadBlocked("database URL must target loopback");
  const cycles = positiveInteger(env.INBOX_RELEASE_WORK_CYCLES ?? env.INBOX_STRESS_WORK_CYCLES, "INBOX_RELEASE_WORK_CYCLES");
  const scenarioPath = requiredString(env.INBOX_RELEASE_SCENARIOS ?? env.INBOX_RELEASE_SCENARIO_FILE, "INBOX_RELEASE_SCENARIOS");
  let decoded;
  try {
    decoded = JSON.parse(await readFile(scenarioPath, "utf8"));
  } catch (error) {
    throw new WorkloadBlocked(`cannot read scenario file: ${scenarioPath}`);
  }
  const scenarios = scenarioEntries(decoded);
  for (const scenario of scenarios) {
    try {
      await access(scenario.storageState, fsConstants.R_OK);
      JSON.parse(await readFile(scenario.storageState, "utf8"));
    } catch {
      throw new WorkloadBlocked(`storage state is unreadable or invalid: ${scenario.storageState}`);
    }
    if (scenario.appUrl && scenario.appUrl !== appUrl) throw new WorkloadBlocked(`scenario ${scenario.tenantId} appUrl does not match INBOX_RELEASE_APP_URL`);
  }
  const jobs = planWork({ scenarios, cycles, concurrency: profile.dimensions.concurrency, tenantCount: profile.dimensions.tenant_count });
  return Object.freeze({ profile, appUrl, databaseUrl, scenarios, cycles, jobs, arrivalIntervalMs: 1000 / profile.dimensions.arrival_rate_rps });
}

function emitTiming(profile, event, durationMs, sample) {
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new Error(`invalid observed duration for ${event}`);
  process.stdout.write(`${JSON.stringify({ type: "timing", profile, event, duration_ms: durationMs, sample })}\n`);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, milliseconds)));
}

/** A detail shell is not an inspection result. Require at least one rendered
 * history row and fail early if the pane has rendered an error. */
export async function waitForDetailState(readState, timeoutMs = 15_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState();
    if (state === "ready") return;
    if (state === "error") throw new WorkloadBlocked("conversation detail rendered an error");
    await sleep(intervalMs);
  }
  throw new WorkloadBlocked("conversation detail did not render history before the bound");
}

async function browserJson(page, path, method = "GET", payload) {
  const result = await page.evaluate(async ({ path: requestPath, method: requestMethod, payload: requestPayload }) => {
    const response = await fetch(requestPath, {
      method: requestMethod,
      credentials: "same-origin",
      cache: "no-store",
      headers: requestMethod === "GET" ? undefined : { "content-type": "application/json" },
      body: requestMethod === "GET" ? undefined : JSON.stringify(requestPayload),
    });
    let body = null;
    try { body = await response.json(); } catch { /* status is retained below */ }
    return { status: response.status, body };
  }, { path, method, payload });
  if (result.status < 200 || result.status >= 300) throw new WorkloadBlocked(`${method} ${path} returned HTTP ${result.status}`);
  if (result.body === null || typeof result.body !== "object") throw new WorkloadBlocked(`${method} ${path} returned a non-JSON body`);
  return result.body;
}

async function findRow(page, orgId, conversationId) {
  const expected = JSON.stringify([orgId, "conversation", conversationId]);
  const index = await page.locator("[data-workspace-row]").evaluateAll((rows, target) => rows.findIndex((row) => row.getAttribute("data-workspace-row") === target), expected);
  if (index < 0) throw new WorkloadBlocked(`pre-seeded conversation ${conversationId} is not in the authenticated workset`);
  return page.locator("[data-workspace-row]").nth(index);
}

async function terminalAction(page, operationId, deadline) {
  let latest;
  while (Date.now() < deadline) {
    latest = await browserJson(page, `/api/inbox/operations/${encodeURIComponent(operationId)}`);
    if (latest.completed === true) return latest;
    await sleep(250);
  }
  throw new WorkloadBlocked(`metadata operation ${operationId} did not reach a terminal receipt before the bound`);
}

async function terminalReply(page, operationId, deadline) {
  let latest;
  while (Date.now() < deadline) {
    latest = await browserJson(page, `/api/inbox/replies/${encodeURIComponent(operationId)}`);
    if (latest.dispatchComplete === true) {
      if (!Array.isArray(latest.receipts) || latest.receipts.length === 0) throw new WorkloadBlocked("reply operation completed without a receipt");
      const itemIds = new Set();
      for (const receipt of latest.receipts) {
        if (!receipt || typeof receipt !== "object" || typeof receipt.itemId !== "string" || itemIds.has(receipt.itemId)) throw new WorkloadBlocked("reply operation returned duplicate or malformed receipts");
        if (receipt.state !== "provider_accepted" && receipt.state !== "delivered") throw new WorkloadBlocked(`reply operation ended with receipt state ${String(receipt.state)}`);
        itemIds.add(receipt.itemId);
      }
      return latest;
    }
    await sleep(250);
  }
  throw new WorkloadBlocked(`reply operation ${operationId} did not reach a terminal receipt before the bound`);
}

async function runCycle(browser, input, job, sample) {
  const scenario = job.scenario;
  const context = await browser.newContext({ baseURL: scenario.appUrl ?? input.appUrl, storageState: scenario.storageState });
  const page = await context.newPage();
  const deadline = Date.now() + positiveNumber(process.env.INBOX_RELEASE_CYCLE_TIMEOUT_MS ?? 120_000, "INBOX_RELEASE_CYCLE_TIMEOUT_MS");
  try {
    await page.goto("/inbox?view=all", { waitUntil: "domcontentloaded", timeout: 30_000 });
    const list = page.getByRole("list", { name: "Inbox conversations", exact: true });
    await list.waitFor({ state: "visible", timeout: 30_000 });
    const row = await findRow(page, scenario.orgId, job.conversationId);
    const firstOpenStart = performance.now();
    await row.getByRole("button", { name: /^Open / }).click();
    await waitForDetailState(async () => page.evaluate(() => {
      const detail = document.querySelector('aside[aria-label="Open conversation"]');
      if (!detail) return "loading";
      if (detail.querySelector('[role="alert"]')) return "error";
      return detail.querySelector('[aria-label="Conversation history"] ol > li') ? "ready" : "loading";
    }));
    emitTiming(input.profile.name, "first_open", performance.now() - firstOpenStart, sample);

    const close = page.getByRole("button", { name: "Close conversation details", exact: true });
    await close.click();
    const revisitStart = performance.now();
    const revisitRow = await findRow(page, scenario.orgId, job.conversationId);
    await revisitRow.getByRole("button", { name: /^Open / }).click();
    await waitForDetailState(async () => page.evaluate(() => {
      const detail = document.querySelector('aside[aria-label="Open conversation"]');
      if (!detail) return "loading";
      if (detail.querySelector('[role="alert"]')) return "error";
      return detail.querySelector('[aria-label="Conversation history"] ol > li') ? "ready" : "loading";
    }));
    emitTiming(input.profile.name, "revisit", performance.now() - revisitStart, sample);

    await page.getByRole("button", { name: "Close conversation details", exact: true }).click();
    const selectionStart = performance.now();
    const selectionRow = await findRow(page, scenario.orgId, job.conversationId);
    const checkbox = selectionRow.getByRole("checkbox", { name: /^Select / });
    await checkbox.check();
    await checkbox.waitFor({ state: "visible" });
    await page.getByText("1 selected", { exact: false }).waitFor({ state: "visible", timeout: 5_000 });
    emitTiming(input.profile.name, "selection", performance.now() - selectionStart, sample);

    const actionKey = randomUUID();
    const metadataPrepared = await browserJson(page, "/api/inbox/actions/prepare", "POST", {
      idempotencyKey: actionKey,
      targets: [{ kind: "conversation", id: job.conversationId }],
      definition: { version: 1, steps: [
        { type: "outcome", value: scenario.outcome },
        { type: "assign", userId: scenario.assigneeId },
        { type: "review_reply", text: scenario.replyTemplate },
      ] },
    });
    const metadataPreparationId = uuid(metadataPrepared.preparationId, "metadata preparationId");
    if (!metadataPrepared.followUp || metadataPrepared.followUp.kind !== "review_reply") throw new WorkloadBlocked("metadata preparation did not return the reviewed-reply follow-up");
    const acceptedMetadata = await browserJson(page, "/api/inbox/actions/accept", "POST", { preparationId: metadataPreparationId, idempotencyKey: actionKey });
    const metadataOperationId = uuid(acceptedMetadata.operationId, "metadata operationId");
    const metadataStatus = await terminalAction(page, metadataOperationId, deadline);
    if (metadataStatus.result !== "succeeded") throw new WorkloadBlocked(`metadata operation ended ${String(metadataStatus.result)}`);
    const metadataRecovery = await browserJson(page, `/api/inbox/operations/recover?preparationId=${encodeURIComponent(metadataPreparationId)}&idempotencyKey=${encodeURIComponent(actionKey)}`);
    if (metadataRecovery.state !== "accepted") throw new WorkloadBlocked("metadata recovery did not return the accepted receipt");

    const replyKey = randomUUID();
    const replyPrepared = await browserJson(page, "/api/inbox/replies/prepare", "POST", { sourceOperationId: metadataOperationId, idempotencyKey: replyKey });
    const replyPreparationId = uuid(replyPrepared.preparationId, "reply preparationId");
    const acceptedReply = await browserJson(page, "/api/inbox/replies/accept", "POST", { preparationId: replyPreparationId, idempotencyKey: replyKey });
    const replyOperationId = uuid(acceptedReply.operationId, "reply operationId");
    await terminalReply(page, replyOperationId, deadline);
    const replyRecovery = await browserJson(page, `/api/inbox/replies/recover?preparationId=${encodeURIComponent(replyPreparationId)}&idempotencyKey=${encodeURIComponent(replyKey)}`);
    if (replyRecovery.state !== "accepted") throw new WorkloadBlocked("reply recovery did not return the accepted receipt");

    return { orgId: scenario.orgId, conversationId: job.conversationId, metadataOperationId, metadataPreparationId, replyPreparationId, replyOperationId, outcome: scenario.outcome, assigneeId: scenario.assigneeId, replyTemplate: scenario.replyTemplate };
  } finally {
    await context.close();
  }
}

async function withConcurrency(jobs, concurrency, task) {
  const results = [];
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= jobs.length) return;
      results[index] = await task(jobs[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

async function verifyDatabaseIdentity(client, env) {
  const identity = await client.query("SELECT current_database() AS database, marker, purpose FROM install_fixture.identity LIMIT 1");
  const row = identity.rows[0];
  if (!row || row.marker !== requiredString(env.INBOX_RELEASE_TARGET_DATABASE_MARKER, "INBOX_RELEASE_TARGET_DATABASE_MARKER")) throw new WorkloadBlocked("database identity marker mismatch");
  for (const relation of ["inbox_operations.operations", "inbox_operations.items", "inbox_reply_review.preparations", "inbox_reply_send.operations"]) {
    const result = await client.query("SELECT to_regclass($1) AS relation", [relation]);
    if (!result.rows[0]?.relation) throw new WorkloadBlocked(`required database relation is absent: ${relation}`);
  }
}

async function verifyPersistedCycle(client, result) {
  const metadata = await client.query("SELECT id, definition FROM inbox_operations.operations WHERE org_id=$1 AND id=$2", [result.orgId, result.metadataOperationId]);
  if (metadata.rowCount !== 1) throw new WorkloadBlocked("accepted metadata operation is not persisted");
  const definition = metadata.rows[0].definition;
  const storedSteps = definition && Array.isArray(definition.steps) ? definition.steps : [];
  const storedReply = storedSteps.at(-1);
  if (!storedReply || storedReply.type !== "review_reply" || storedReply.text !== result.replyTemplate) throw new WorkloadBlocked("metadata operation did not retain the immutable reviewed-reply template");
  const steps = await client.query("SELECT action, state, payload FROM inbox_operations.steps WHERE org_id=$1 AND operation_id=$2 ORDER BY ordinal", [result.orgId, result.metadataOperationId]);
  if (steps.rowCount !== 2 || steps.rows.some((step) => step.state !== "succeeded")) throw new WorkloadBlocked("metadata operation has missing or non-successful steps");
  const outcome = steps.rows.find((step) => step.action === "outcome");
  const assignment = steps.rows.find((step) => step.action === "assign");
  if (!outcome || !assignment || outcome.payload?.value !== result.outcome || assignment.payload?.user_id !== result.assigneeId) throw new WorkloadBlocked("metadata operation steps do not retain the requested outcome and assignment");
  const item = await client.query("SELECT id, resolution->>'property_id' AS property_id, exclusion_code FROM inbox_operations.items WHERE org_id=$1 AND operation_id=$2 AND target_kind='conversation' AND target_id=$3", [result.orgId, result.metadataOperationId, result.conversationId]);
  if (item.rowCount !== 1) throw new WorkloadBlocked("metadata operation did not retain the selected conversation");
  if (item.rows[0].exclusion_code !== null || !UUID.test(item.rows[0].property_id ?? "")) throw new WorkloadBlocked("metadata operation did not retain an eligible property target");
  const property = await client.query("SELECT outreach_dispo, assigned_user_id FROM public.properties WHERE org_id=$1 AND id=$2", [result.orgId, item.rows[0].property_id]);
  if (property.rowCount !== 1 || property.rows[0].outreach_dispo !== result.outcome || property.rows[0].assigned_user_id !== result.assigneeId) throw new WorkloadBlocked("metadata side effects do not match the requested outcome and assignment");
  const replyPreparation = await client.query("SELECT id, canonical_input FROM inbox_reply_review.preparations WHERE org_id=$1 AND id=$2", [result.orgId, result.replyPreparationId]);
  if (replyPreparation.rowCount !== 1 || typeof replyPreparation.rows[0].canonical_input !== "string" || !replyPreparation.rows[0].canonical_input.includes(result.conversationId)) throw new WorkloadBlocked("reply preparation did not retain the selected conversation");
  const reply = await client.query("SELECT id FROM inbox_reply_send.operations WHERE org_id=$1 AND id=$2", [result.orgId, result.replyOperationId]);
  if (reply.rowCount !== 1) throw new WorkloadBlocked("accepted reply operation is not persisted");
  const attempts = await client.query("SELECT item_id, state, receipt_version FROM inbox_reply_send.attempts WHERE org_id=$1 AND operation_id=$2 ORDER BY item_id, attempt_ordinal", [result.orgId, result.replyOperationId]);
  const attemptItems = new Set();
  if (attempts.rowCount === 0) throw new WorkloadBlocked("reply operation has no persisted receipt");
  for (const attempt of attempts.rows) {
    if (attemptItems.has(attempt.item_id) || (attempt.state !== "provider_accepted" && attempt.state !== "delivered") || Number(attempt.receipt_version) <= 0) throw new WorkloadBlocked("reply operation has duplicate or unsuccessful provider-double receipts");
    attemptItems.add(attempt.item_id);
  }
}

export async function main(env = process.env) {
  const input = await loadRuntimeInput(env);
  const { chromium } = await import("@playwright/test");
  const { Client } = await import("pg");
  const database = new Client({ connectionString: input.databaseUrl, connectionTimeoutMillis: 5_000, statement_timeout: 3_000 });
  await database.connect();
  let browser;
  try {
    await database.query("BEGIN TRANSACTION READ ONLY");
    try {
      await verifyDatabaseIdentity(database, env);
    } finally {
      await database.query("ROLLBACK").catch(() => {});
    }
    browser = await chromium.launch({ headless: env.INBOX_RELEASE_HEADLESS !== "false" });
    const startedAt = performance.now();
    const results = await withConcurrency(input.jobs, input.profile.dimensions.concurrency, async (job) => {
      const delay = job.index * input.arrivalIntervalMs - (performance.now() - startedAt);
      if (delay > 0) await sleep(delay);
      return runCycle(browser, input, job, job.index + 1);
    });
    if (new Set(results.map((result) => result.metadataOperationId)).size !== results.length || new Set(results.map((result) => result.replyOperationId)).size !== results.length) throw new WorkloadBlocked("workload produced duplicate operation receipts");
    await database.query("BEGIN TRANSACTION READ ONLY");
    try {
      await verifyDatabaseIdentity(database, env);
      for (const result of results) await verifyPersistedCycle(database, result);
    } finally {
      await database.query("ROLLBACK").catch(() => {});
    }
  } finally {
    await browser?.close();
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
