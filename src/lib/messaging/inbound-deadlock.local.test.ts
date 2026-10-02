import { afterEach, describe, expect, it } from "vitest";
import { Client } from "pg";

import { insertInboundMessage } from "./inbound";

const dbUrl = process.env.TEST_SUPABASE_DB_URL ?? "";
const localDb = /^postgresql:\/\/postgres:[^@]+@127\.0\.0\.1:\d+\//.test(dbUrl);
const describeLocal = localDb ? describe : describe.skip;
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

async function controlHandlerWithoutRetry(client: Client) {
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
    if ((error as { code?: string }).code === "40P01") return { status: 500 };
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
    await reader.query("commit");
    const insertOutcome = await insertResult;
    return { insertOutcome, readOutcome };
  } finally {
    await reader.query("rollback").catch(() => undefined);
    await Promise.all([inbound.end(), reader.end()]);
  }
}

function pgSupabaseClient(
  client: Client,
  counters: {
    insertAttempts: number;
    threadUpdates: number;
    intentUpdates: number;
  },
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

let admin: Client;

describeLocal("inbound deadlock local proof", () => {
  afterEach(async () => {
    if (!admin) return;
    await cleanupFixture(admin);
    await admin.end();
  });

  it("control: one raw insert gets 40P01 and saves no row", async () => {
    admin = new Client({
      connectionString: dbUrl,
      application_name: "local-deadlock-admin",
    });
    await admin.connect();
    await setupFixture(admin);
    const result = await runCycle(admin, (client) =>
      controlHandlerWithoutRetry(client),
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
    expect(count.rows[0].count).toBe(0);
  });

  it("retry: the same boundary retries once, saves one row, and clears thread state once", async () => {
    admin = new Client({
      connectionString: dbUrl,
      application_name: "local-deadlock-admin",
    });
    await admin.connect();
    await setupFixture(admin);
    const counters = { insertAttempts: 0, threadUpdates: 0, intentUpdates: 0 };
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
    expect(counters.threadUpdates).toBe(1);
    expect(counters.intentUpdates).toBe(1);
    expect(count.rows[0].count).toBe(1);
  });
});
