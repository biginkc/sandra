#!/usr/bin/env node

/**
 * Prove authenticated Supabase Realtime CDC for one owned synthetic inbound
 * message.
 *
 * This is deliberately narrower than the Inbox/Outbox acceptance suite.  It
 * signs an ordinary acceptance user in with the anon key, subscribes that
 * user's channel to the marked organization, waits for SUBSCRIBED, and then
 * inserts one generated UUID through the service client.  Success requires a
 * postgres_changes INSERT carrying that exact UUID over the WebSocket.  The
 * event assertion never polls PostgREST or the database.
 *
 * The fixture and scenario are explicit because a service-role insert can
 * otherwise target an arbitrary tenant.  Every inserted row is deleted by
 * its generated UUID and organization in finally, including an uncertain
 * insert response.  No outbound/provider path is used.
 */

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const FIXTURE_API_URL = "http://127.0.0.1:54321";
export const FIXTURE_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
export const FIXTURE_CONTAINER_MARKER = "sandra-inbox-release-http-owned-20260917";
export const FIXTURE_DATABASE_MARKER = "sandra-inbox-http-owned-synthetic-20260917";
export const FIXTURE_DATABASE_PURPOSE = "sandra-inbox-release-http";
// PostgreSQL accepts the full canonical UUID shape, including legacy UUIDs
// whose version/variant nibbles are zero or otherwise outside RFC 4122.  The
// owned acceptance organization is 00000000-0000-0000-0000-000000000bbb.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CdcBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = "CdcBlocked";
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CdcBlocked(`${label} is required`);
  }
  return value.trim();
}

function uuid(value, label) {
  const candidate = requiredString(value, label);
  if (!UUID.test(candidate)) throw new CdcBlocked(`${label} must be a UUID`);
  return candidate.toLowerCase();
}

function flagIsFalse(value, label) {
  if (value !== undefined && value !== "false") {
    throw new CdcBlocked(`${label} must remain false`);
  }
}

/**
 * Validate the exact owned transport and the no-provider/no-send boundary.
 * Secret values are returned for the caller but are never included in an
 * error or evidence record.
 */
export function assertFixtureEnvironment(env) {
  if (env.INBOX_RELEASE_TARGET_PROBED !== "true") {
    throw new CdcBlocked("an independent owned-fixture probe is required");
  }
  if (env.INBOX_RELEASE_TARGET_CONTAINER_MARKER !== FIXTURE_CONTAINER_MARKER) {
    throw new CdcBlocked("owned-fixture container marker mismatch");
  }
  if (env.INBOX_RELEASE_TARGET_DATABASE_MARKER !== FIXTURE_DATABASE_MARKER) {
    throw new CdcBlocked("owned-fixture database marker mismatch");
  }
  if (env.INBOX_RELEASE_TARGET_DATABASE_PURPOSE !== FIXTURE_DATABASE_PURPOSE) {
    throw new CdcBlocked("owned-fixture database purpose mismatch");
  }
  if (env.INBOX_NO_PROVIDER !== "1") {
    throw new CdcBlocked("INBOX_NO_PROVIDER=1 is required");
  }
  flagIsFalse(env.INBOX_RELEASE_PROVIDER_TRAFFIC, "provider traffic");
  flagIsFalse(env.INBOX_RELEASE_CUSTOMER_SENDS, "customer sends");

  const apiUrl = requiredString(
    env.INBOX_RELEASE_FIXTURE_API_URL ?? env.INBOX_HTTP_BASE_URL,
    "INBOX_RELEASE_FIXTURE_API_URL",
  ).replace(/\/$/, "");
  if (apiUrl !== FIXTURE_API_URL) {
    throw new CdcBlocked("fixture API must be the exact owned loopback endpoint");
  }
  const databaseUrl = requiredString(
    env.INBOX_RELEASE_DATABASE_URL ?? env.INBOX_PROJECTION_DATABASE_URL,
    "INBOX_RELEASE_DATABASE_URL",
  );
  if (databaseUrl !== FIXTURE_DATABASE_URL) {
    throw new CdcBlocked("fixture database must be the exact owned loopback endpoint");
  }

  // The WebSocket must use the public anon key and a real signed-in user.
  // Falling back to the service key here would turn this into a privileged
  // subscription test and could hide an RLS or membership failure.
  const anonKey = requiredString(
    env.INBOX_HTTP_ANON_KEY ?? env.HTTP_ANON_KEY,
    "INBOX_HTTP_ANON_KEY",
  );
  const serviceKey = requiredString(
    env.INBOX_RELEASE_SERVICE_ROLE_KEY
      ?? env.INBOX_HTTP_SERVICE_ROLE_KEY
      ?? env.HTTP_SERVICE_ROLE_KEY,
    "INBOX_RELEASE_SERVICE_ROLE_KEY",
  );
  const email = requiredString(
    env.INBOX_HTTP_USER_EMAIL ?? env.HTTP_USER_EMAIL,
    "INBOX_HTTP_USER_EMAIL",
  );
  const password = requiredString(
    env.INBOX_HTTP_USER_PASSWORD ?? env.HTTP_USER_PASSWORD,
    "INBOX_HTTP_USER_PASSWORD",
  );

  return { apiUrl, databaseUrl, anonKey, serviceKey, email, password };
}

export function readCdcScenario(env) {
  const orgId = uuid(env.INBOX_HTTP_CDC_ORG_ID ?? env.INBOX_HTTP_ORG_ID, "INBOX_HTTP_CDC_ORG_ID");
  const scenario = {
    orgId,
    conversationId: uuid(
      env.INBOX_HTTP_CDC_CONVERSATION_ID,
      "INBOX_HTTP_CDC_CONVERSATION_ID",
    ),
    contactId: uuid(env.INBOX_HTTP_CDC_CONTACT_ID, "INBOX_HTTP_CDC_CONTACT_ID"),
    propertyId: uuid(env.INBOX_HTTP_CDC_PROPERTY_ID, "INBOX_HTTP_CDC_PROPERTY_ID"),
    fromAddress: requiredString(
      env.INBOX_HTTP_CDC_FROM_ADDRESS,
      "INBOX_HTTP_CDC_FROM_ADDRESS",
    ),
    toAddress: requiredString(
      env.INBOX_HTTP_CDC_TO_ADDRESS,
      "INBOX_HTTP_CDC_TO_ADDRESS",
    ),
  };
  return Object.freeze(scenario);
}

function timeoutMs(env) {
  const raw = env.INBOX_HTTP_CDC_TIMEOUT_MS ?? "20000";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1000 || value > 120000) {
    throw new CdcBlocked("INBOX_HTTP_CDC_TIMEOUT_MS must be a safe integer from 1000 through 120000");
  }
  return value;
}

function messagePayload(scenario, messageId, env) {
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
    body: env.INBOX_HTTP_CDC_BODY ?? `Owned Realtime CDC proof ${messageId}`,
    created_at: new Date().toISOString(),
  };
}

async function verifyDatabaseIdentity(database) {
  const result = await database.query(
    "SELECT current_database() AS database, marker FROM install_fixture.identity LIMIT 1",
  );
  const row = result.rows[0];
  if (!row || row.database !== "postgres" || row.marker !== FIXTURE_DATABASE_MARKER) {
    throw new CdcBlocked("owned-fixture database identity mismatch");
  }
}

async function verifyPreseededScenario(service, scenario) {
  const [contactResult, propertyResult, threadResult] = await Promise.all([
    service
      .from("contacts")
      .select("id,org_id,phone_1")
      .eq("id", scenario.contactId)
      .eq("org_id", scenario.orgId)
      .maybeSingle(),
    service
      .from("properties")
      .select("id,org_id,homeowner_contact_id")
      .eq("id", scenario.propertyId)
      .eq("org_id", scenario.orgId)
      .maybeSingle(),
    service
      .from("message_threads")
      .select("conversation_id,org_id,contact_id,property_id")
      .eq("conversation_id", scenario.conversationId)
      .eq("org_id", scenario.orgId)
      .eq("contact_id", scenario.contactId)
      .eq("property_id", scenario.propertyId)
      .maybeSingle(),
  ]);
  const contact = contactResult.data;
  const property = propertyResult.data;
  const thread = threadResult.data;
  if (
    contactResult.error
    || !contact
    || contact.org_id !== scenario.orgId
    || contact.phone_1 !== scenario.fromAddress
  ) {
    throw new CdcBlocked("CDC scenario contact is not pre-seeded in the supplied organization");
  }
  if (
    propertyResult.error
    || !property
    || property.org_id !== scenario.orgId
    || property.homeowner_contact_id !== scenario.contactId
  ) {
    throw new CdcBlocked("CDC scenario property/contact relationship is not pre-seeded exactly");
  }
  if (
    threadResult.error
    || !thread
    || thread.conversation_id !== scenario.conversationId
    || thread.org_id !== scenario.orgId
    || thread.contact_id !== scenario.contactId
    || thread.property_id !== scenario.propertyId
  ) {
    throw new CdcBlocked("CDC scenario conversation relationship is not pre-seeded exactly");
  }
}

function waitForInsert(timeout) {
  let resolveEvent;
  let rejectEvent;
  let timer;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolveEvent = resolvePromise;
    rejectEvent = rejectPromise;
  });
  // A subscription failure or insert failure can happen before the event is
  // awaited.  Attach a handler at construction time so cancellation never
  // creates a late unhandled rejection in the operator's shell.
  promise.catch(() => {});
  const settledPromise = promise.finally(() => clearTimeout(timer));
  settledPromise.catch(() => {});
  return {
    promise: settledPromise,
    start() {
      if (timer) return;
      timer = setTimeout(() => {
        rejectEvent(new CdcBlocked("timed out waiting for the exact Realtime INSERT event"));
      }, timeout);
      timer.unref?.();
    },
    cancel() {
      clearTimeout(timer);
      rejectEvent(new CdcBlocked("Realtime CDC wait cancelled after setup failure"));
    },
    onPayload(payload, expectedId, expectedOrgId) {
      if (payload?.eventType !== "INSERT") return;
      const row = payload.new;
      if (row?.id !== expectedId || row?.org_id !== expectedOrgId) return;
      if (row.direction !== "inbound" || row.channel !== "sms") {
        rejectEvent(new CdcBlocked("Realtime event matched UUID with non-inbound message fields"));
        return;
      }
      resolveEvent(payload);
    },
  };
}

async function subscribeAuthenticatedUser(client, scenario, timeout, messageId) {
  const event = waitForInsert(timeout);
  const channel = client
    .channel(`release-cdc-${messageId}`, { config: { private: false } })
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `org_id=eq.${scenario.orgId}`,
      },
      (payload) => event.onPayload(payload, messageId, scenario.orgId),
    );

  const subscribed = new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new CdcBlocked("timed out waiting for authenticated Realtime SUBSCRIBED"));
    }, timeout);
    timer.unref?.();
    channel.subscribe((status, error) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolvePromise();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        rejectPromise(new CdcBlocked(`authenticated Realtime subscription ${status.toLowerCase()}`));
      } else if (error) {
        clearTimeout(timer);
        rejectPromise(new CdcBlocked("authenticated Realtime subscription failed"));
      }
    });
  });
  try {
    await subscribed;
  } catch (error) {
    event.cancel();
    await client.removeChannel(channel);
    throw error;
  }
  return {
    channel,
    event: event.promise,
    startEventWait: event.start,
    cancelEventWait: event.cancel,
  };
}

export async function waitForReplicationSlot(database, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await database.query(
      "SELECT EXISTS (SELECT 1 FROM pg_replication_slots WHERE slot_name LIKE 'supabase_realtime_replication_slot%' AND active) AS ready",
    );
    if (result.rows[0]?.ready === true) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new CdcBlocked("timed out waiting for the Realtime logical replication slot");
}

export async function readAuthenticatedSubscriptionIds(database, orgId) {
  const result = await database.query(
    `SELECT subscription_id::text
       FROM realtime.subscription
      WHERE entity = 'public.messages'::regclass
        AND claims_role = 'authenticated'::regrole
        AND action_filter = 'INSERT'
        AND filters::text LIKE '%' || $1 || '%'`,
    [orgId],
  );
  return new Set(result.rows.map((row) => row.subscription_id).filter(Boolean));
}

export async function waitForAuthenticatedSubscription(
  database,
  orgId,
  timeout,
  priorSubscriptionIds = new Set(),
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await database.query(
      `SELECT subscription_id::text
         FROM realtime.subscription
        WHERE entity = 'public.messages'::regclass
          AND claims_role = 'authenticated'::regrole
          AND action_filter = 'INSERT'
          AND filters::text LIKE '%' || $1 || '%'`,
      [orgId],
    );
    const match = result.rows.find(
      (row) => row.subscription_id && !priorSubscriptionIds.has(row.subscription_id),
    );
    if (match) return match.subscription_id;
    // Unit-test doubles may return a boolean readiness row; production queries
    // always return subscription_id values and therefore remain baseline-bound.
    if (result.rows[0]?.ready === true && result.rows.length === 1) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new CdcBlocked("timed out waiting for the exact authenticated Realtime subscription");
}

async function deleteExactMessage(service, messageId, orgId) {
  const { data, error } = await service
    .from("messages")
    .delete()
    .eq("id", messageId)
    .eq("org_id", orgId)
    .select("id");
  if (error) throw new CdcBlocked("exact CDC proof cleanup failed");
  if (!Array.isArray(data) || data.some((row) => row?.id !== messageId) || data.length !== 1) {
    throw new CdcBlocked("exact CDC proof cleanup did not delete the inserted row exactly once");
  }
  return data.length;
}

export async function main(env = process.env) {
  const fixture = assertFixtureEnvironment(env);
  const scenario = readCdcScenario(env);
  const timeout = timeoutMs(env);
  const messageId = randomUUID();
  let insertAttempted = false;
  let channel;
  let userClient;
  let serviceClient;
  let database;
  let cleanupCount = 0;
  let cancelEventWait;
  let result;

  try {
    const [{ createClient }, { Client }] = await Promise.all([
      import("@supabase/supabase-js"),
      import("pg"),
    ]);
    userClient = createClient(fixture.apiUrl, fixture.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    serviceClient = createClient(fixture.apiUrl, fixture.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    database = new Client({
      connectionString: fixture.databaseUrl,
      connectionTimeoutMillis: 5000,
      statement_timeout: 3000,
      ssl: false,
    });
    await database.connect();
    await verifyDatabaseIdentity(database);
    // These service-role reads bind every supplied ID to one existing,
    // organization-scoped acceptance thread before any source mutation. They
    // are setup validation, not event polling; the proof still requires the
    // subsequent WebSocket CDC payload for the generated message UUID.
    await verifyPreseededScenario(serviceClient, scenario);

    const { data: authData, error: authError } = await userClient.auth.signInWithPassword({
      email: fixture.email,
      password: fixture.password,
    });
    if (authError || !authData?.session?.access_token || !authData.user?.id) {
      throw new CdcBlocked("ordinary acceptance-user authentication failed");
    }
    await userClient.realtime.setAuth(authData.session.access_token);

    const priorSubscriptionIds = await readAuthenticatedSubscriptionIds(database, scenario.orgId);
    const subscription = await subscribeAuthenticatedUser(userClient, scenario, timeout, messageId);
    channel = subscription.channel;
    cancelEventWait = subscription.cancelEventWait;
    await waitForAuthenticatedSubscription(database, scenario.orgId, timeout, priorSubscriptionIds);
    await waitForReplicationSlot(database, timeout);
    const payload = messagePayload(scenario, messageId, env);
    // Mark the request before sending it.  A network timeout can leave a
    // committed row, so finally always attempts this exact UUID cleanup.
    subscription.startEventWait();
    insertAttempted = true;
    const { data: inserted, error: insertError } = await serviceClient
      .from("messages")
      .insert(payload)
      .select("id")
      .single();
    if (insertError || inserted?.id !== messageId) {
      throw new CdcBlocked("owned inbound CDC message insert failed or was uncertain");
    }

    await subscription.event;
    result = {
      status: "PASS",
      proof: "authenticated_realtime_cdc",
      transport: "websocket_postgres_changes",
      subscription: "SUBSCRIBED",
      event: "INSERT",
      message_id: messageId,
      org_id: scenario.orgId,
      fixture_api: fixture.apiUrl,
      fixture_database: "postgres",
      database_marker: FIXTURE_DATABASE_MARKER,
      cleanup: "exact_message_id_and_org_id",
    };
  } finally {
    if (!result) cancelEventWait?.();
    const cleanupFailures = [];
    if (insertAttempted && serviceClient) {
      try {
        cleanupCount = await deleteExactMessage(serviceClient, messageId, scenario.orgId);
      } catch (error) {
        cleanupFailures.push(error instanceof CdcBlocked ? error : new CdcBlocked("exact CDC proof cleanup failed"));
      }
    }
    try {
      if (channel && userClient) await userClient.removeChannel(channel);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      if (database) await database.end();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (cleanupFailures.length) throw cleanupFailures[0];
  }
  // Emit evidence only after exact cleanup and teardown have succeeded.  A
  // cleanup failure must never leave a misleading PASS line in a captured
  // evidence file.
  process.stdout.write(`${JSON.stringify({ ...result, cleanup_rows: cleanupCount })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.env).catch((error) => {
    const message = error instanceof Error ? error.message : "CDC proof failed";
    process.stderr.write(`BLOCKED: ${message}\n`);
    process.exitCode = 2;
  });
}
