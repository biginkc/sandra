import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "pg";

import { insertInboundMessage } from "./inbound";

const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? "";
const localDb = /^postgresql:\/\/postgres:[^@]+@127\.0\.0\.1:\d+\//.test(dbUrl);
const ORG = "00000000-0000-0000-0000-000000000bbb";
const CONTACT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROPERTY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONVERSATION = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OLD_MESSAGE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const INTENT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CONTROL_EXTERNAL_ID = "local-deadlock-control";
const RETRY_EXTERNAL_ID = "local-deadlock-retry";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const rawInsertSql = `
  insert into public.messages
    (org_id, channel, direction, contact_id, property_id, conversation_id,
     provider, from_address, to_address, body, status, external_id, metadata,
     inbound_intent_id, attributed_outbound_message_id)
  values ($1, 'sms', 'inbound', $2, $3, $4, 'sendillo', '+18165550100',
    '+18165550199', 'new inbound', 'received', $5, $6, $7, $8)
  returning id, metadata, contact_id, property_id, conversation_id`;

type ErrorResult = { ok: false; code?: string; message?: string };
type DeadlockCounters = {
  insertAttempts: number;
  threadUpdates: number;
  intentUpdates: number;
  deadlockErrors: number;
};

async function controlHandlerWithoutRetry(
  client: Client,
  counters: Pick<DeadlockCounters, "deadlockErrors">,
) {
  try {
    await client.query(rawInsertSql, [
      ORG,
      CONTACT,
      PROPERTY,
      CONVERSATION,
      CONTROL_EXTERNAL_ID,
      null,
      null,
      null,
    ]);
    return { status: 200 };
  } catch (error) {
    if ((error as { code?: string }).code === "40P01") {
      counters.deadlockErrors += 1;
      return { status: 500 };
    }
    throw error;
  }
}

async function waitForLock(observer: Client, pid: number) {
  for (let i = 0; i < 400; i += 1) {
    const { rows } = await observer.query(
      "select wait_event_type from pg_stat_activity where pid=$1",
      [pid],
    );
    if (rows[0]?.wait_event_type === "Lock") return;
    await sleep(25);
  }
  throw new Error(`lock barrier timeout for pid ${pid}`);
}

async function setupFixture(admin: Client) {
  await admin.query(
    "delete from public.messages where id in ($1,$2) or external_id in ($3,$4)",
    [
      OLD_MESSAGE,
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      CONTROL_EXTERNAL_ID,
      RETRY_EXTERNAL_ID,
    ],
  );
  await admin.query("delete from public.sms_inbound_intents where id=$1", [
    INTENT,
  ]);
  await admin.query("delete from public.properties where id=$1", [PROPERTY]);
  await admin.query("delete from public.contacts where id=$1", [CONTACT]);
  await admin.query(
    "insert into public.contacts(id,org_id,contact_type,first_name,last_name) values($1,$2,'person','Deadlock','Probe')",
    [CONTACT, ORG],
  );
  await admin.query(
    "insert into public.properties(id,org_id,address,state,homeowner_contact_id,status) values($1,$2,'1 Local Proof Way','MO',$3,'new_lead')",
    [PROPERTY, ORG, CONTACT],
  );
  await admin.query(
    `insert into public.sms_inbound_intents
      (id,org_id,provider,from_address,to_address,body_fingerprint,dedupe_scope_hash,
       received_at,dedupe_range,contact_id,property_id,conversation_id,
       first_provider_message_id,last_provider_message_id)
     values($1,$2,'sendillo','+18165550100','+18165550199','local-proof-fingerprint',
       'local-proof-scope',current_timestamp,
       tstzrange(current_timestamp,current_timestamp + interval '1 second','[)'),
       $3,$4,$5,'local-deadlock-intent','local-deadlock-intent')`,
    [INTENT, ORG, CONTACT, PROPERTY, CONVERSATION],
  );
  await admin.query(
    `insert into public.messages
      (id,org_id,channel,direction,contact_id,property_id,conversation_id,provider,
       from_address,to_address,body,status,external_id,read_at)
     values($1,$2,'sms','inbound',$3,$4,$5,'sendillo','+18165550100',
       '+18165550199','old unread','received','local-deadlock-old',null)`,
    [OLD_MESSAGE, ORG, CONTACT, PROPERTY, CONVERSATION],
  );
}

async function cleanupFixture(admin: Client) {
  await admin.query(
    "delete from public.messages where id=$1 or external_id in ($2,$3)",
    [OLD_MESSAGE, CONTROL_EXTERNAL_ID, RETRY_EXTERNAL_ID],
  );
  await admin.query("delete from public.sms_inbound_intents where id=$1", [
    INTENT,
  ]);
  await admin.query("delete from public.properties where id=$1", [PROPERTY]);
  await admin.query("delete from public.contacts where id=$1", [CONTACT]);
}

async function dirtyGeneration(client: Client) {
  const { rows } = await client.query(
    `select generation
       from inbox_message_capture.dirty
      where org_id=$1 and target_kind='known_conversation' and target_id=$2`,
    [ORG, CONVERSATION],
  );
  if (rows.length !== 1) {
    throw new Error("expected exactly one dirty(C) row");
  }
  return Number(rows[0].generation);
}

async function runCycle(
  admin: Client,
  operation: (client: Client) => Promise<unknown>,
) {
  const inbound = new Client({
    connectionString: dbUrl,
    application_name: "local-deadlock-inbound",
  });
  const reader = new Client({
    connectionString: dbUrl,
    application_name: "local-deadlock-reader",
  });
  await Promise.all([inbound.connect(), reader.connect()]);
  const inboundPid = (await inbound.query("select pg_backend_pid() pid"))
    .rows[0].pid as number;
  const readerPid = (await reader.query("select pg_backend_pid() pid")).rows[0]
    .pid as number;
  try {
    const beforeGeneration = await dirtyGeneration(admin);
    await reader.query("begin");
    await reader.query("set local deadlock_timeout='30s'");
    await reader.query(
      "select id from public.properties where id=$1 for no key update",
      [PROPERTY],
    );
    await inbound.query("set deadlock_timeout='1s'");
    await inbound.query("set statement_timeout='15s'");

    const insertResult = operation(inbound).then(
      (value) => ({ ok: true as const, value }),
      (error: ErrorResult) => ({
        ok: false as const,
        code: error.code,
        message: error.message,
      }),
    );
    await waitForLock(admin, inboundPid);

    const readResult = reader.query(
      "update public.messages set read_at=statement_timestamp() where id=$1",
      [OLD_MESSAGE],
    );
    await waitForLock(admin, readerPid);
    const readOutcome = await readResult;
    const afterReadGeneration = await dirtyGeneration(reader);
    await reader.query("commit");
    const insertOutcome = await insertResult;
    const afterInboundGeneration = await dirtyGeneration(admin);
    return {
      insertOutcome,
      readOutcome,
      dirtyGeneration: {
        before: beforeGeneration,
        afterRead: afterReadGeneration,
        afterInbound: afterInboundGeneration,
      },
    };
  } finally {
    await reader.query("rollback").catch(() => undefined);
    await Promise.all([inbound.end(), reader.end()]);
  }
}

function pgSupabaseClient(
  client: Client,
  counters: DeadlockCounters,
) {
  const messageLookup = () => {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      limit: () => builder,
      maybeSingle: async () => {
        const { rows } = await client.query(
          `select id, metadata, contact_id, property_id, conversation_id
             from public.messages
            where channel=$1 and direction=$2 and provider=$3 and external_id=$4
            limit 1`,
          [
            filters.channel,
            filters.direction,
            filters.provider,
            filters.external_id,
          ],
        );
        return { data: rows[0] ?? null, error: null };
      },
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) =>
        client
          .query(
            `select id, metadata, contact_id, property_id, conversation_id
               from public.messages
              where channel=$1 and direction=$2 and provider=$3 and external_id=$4
              limit 1`,
            [
              filters.channel,
              filters.direction,
              filters.provider,
              filters.external_id,
            ],
          )
          .then(({ rows }) => resolve({ data: rows, error: null }), reject),
    };
    return builder;
  };

  const updateBuilder = (table: string) => {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      then: (
        resolve: (value: unknown) => unknown,
        reject?: (reason: unknown) => unknown,
      ) => {
        if (table === "message_threads") counters.threadUpdates += 1;
        if (table === "sms_inbound_intents") counters.intentUpdates += 1;
        return client
          .query("select 1", [])
          .then(() => resolve({ data: null, error: null }), reject);
      },
    };
    return builder;
  };

  const insertMessage = (payload: Record<string, unknown>) => ({
    select: () => ({
      maybeSingle: async () => {
        counters.insertAttempts += 1;
        try {
          const { rows } = await client.query(
            `insert into public.messages
              (channel,direction,status,provider,external_id,from_address,to_address,body,
               contact_id,property_id,conversation_id,inbound_intent_id,
               attributed_outbound_message_id,metadata)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             returning id, metadata, contact_id, property_id, conversation_id`,
            [
              payload.channel,
              payload.direction,
              payload.status,
              payload.provider,
              payload.external_id,
              payload.from_address,
              payload.to_address,
              payload.body,
              payload.contact_id,
              payload.property_id,
              payload.conversation_id,
              payload.inbound_intent_id,
              payload.attributed_outbound_message_id,
              payload.metadata,
            ],
          );
          return { data: rows[0] ?? null, error: null };
        } catch (error) {
          const typed = error as { code?: string; message?: string };
          if (typed.code === "40P01") counters.deadlockErrors += 1;
          return {
            data: null,
            error: { code: typed.code, message: typed.message },
          };
        }
      },
    }),
  });

  return {
    from(table: string) {
      if (table === "messages") {
        return {
          select: () => messageLookup(),
          insert: insertMessage,
        };
      }
      if (table === "message_threads") {
        return { update: () => updateBuilder(table) };
      }
      return { update: () => updateBuilder(table) };
    },
  };
}

let admin: Client | undefined;

describe("inbound deadlock local proof", () => {
  beforeEach(async ({ skip }) => {
    if (!localDb) {
      skip(
        "TEST_SUPABASE_DB_URL must point to a local PostgreSQL database on 127.0.0.1",
      );
      return;
    }

    const probe = new Client({
      connectionString: dbUrl,
      application_name: "local-deadlock-schema-probe",
    });
    let skipReason: string | null = null;
    try {
      await probe.connect();
      const { rows } = await probe.query(
        "select to_regclass('inbox_message_capture.dirty') is not null as inbox_schema_present",
      );
      if (rows[0]?.inbox_schema_present !== true) {
        skipReason =
          "target database is missing inbox_message_capture.dirty; apply the Inbox migrations to run this proof";
      }
    } catch {
      skipReason =
        "could not verify inbox_message_capture.dirty; refusing to run the local proof without the Inbox schema";
    } finally {
      await probe.end().catch(() => undefined);
    }
    if (skipReason) skip(skipReason);
  });

  afterEach(async () => {
    if (!admin) return;
    await cleanupFixture(admin);
    await admin.end();
    admin = undefined;
  });

  it("control: one raw insert gets 40P01 and saves no row", async () => {
    admin = new Client({
      connectionString: dbUrl,
      application_name: "local-deadlock-admin",
    });
    await admin.connect();
    await setupFixture(admin);
    const counters = { deadlockErrors: 0 };
    const result = await runCycle(admin, (client) =>
      controlHandlerWithoutRetry(client, counters),
    );
    const count = await admin.query(
      "select count(*)::int as count from public.messages where external_id=$1",
      [CONTROL_EXTERNAL_ID],
    );
    expect(result.insertOutcome).toMatchObject({
      ok: true,
      value: { status: 500 },
    });
    expect(result.readOutcome.rowCount).toBe(1);
    expect(counters.deadlockErrors).toBe(1);
    expect(result.dirtyGeneration.afterRead).toBe(
      result.dirtyGeneration.before + 1,
    );
    expect(result.dirtyGeneration.afterInbound).toBe(
      result.dirtyGeneration.afterRead,
    );
    expect(count.rows[0].count).toBe(0);
  });

  it("retry: the same boundary retries once, saves one row, and clears thread state once", async () => {
    admin = new Client({
      connectionString: dbUrl,
      application_name: "local-deadlock-admin",
    });
    await admin.connect();
    await setupFixture(admin);
    const counters = {
      insertAttempts: 0,
      threadUpdates: 0,
      intentUpdates: 0,
      deadlockErrors: 0,
    };
    const result = await runCycle(admin, (client) =>
      insertInboundMessage(pgSupabaseClient(client, counters) as never, {
        providerId: "sendillo",
        externalId: RETRY_EXTERNAL_ID,
        from: "+18165550100",
        to: "+18165550199",
        body: "new inbound",
        contactId: CONTACT,
        propertyId: PROPERTY,
        conversationId: CONVERSATION,
        inboundIntentId: INTENT,
        attributedOutboundMessageId: null,
        metadata: { source: "local-proof" },
      }),
    );
    const count = await admin.query(
      "select count(*)::int as count from public.messages where external_id=$1",
      [RETRY_EXTERNAL_ID],
    );
    expect(result.insertOutcome).toMatchObject({ ok: true });
    expect(result.readOutcome.rowCount).toBe(1);
    expect(counters.insertAttempts).toBe(2);
    expect(counters.deadlockErrors).toBe(1);
    expect(counters.threadUpdates).toBe(1);
    expect(counters.intentUpdates).toBe(1);
    expect(result.dirtyGeneration.afterRead).toBe(
      result.dirtyGeneration.before + 1,
    );
    expect(result.dirtyGeneration.afterInbound).toBe(
      result.dirtyGeneration.afterRead + 1,
    );
    expect(count.rows[0].count).toBe(1);
  });
});
