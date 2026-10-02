import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { runSequenceTick } from "@/app/api/cron/sequence-tick/handlers";
import { releaseQueuedMessage } from "@/lib/messaging/send";
import { MockMessagingProvider } from "@/lib/messaging/providers/mock";
import { stopOwnedHolder } from "./inbox-test-readonly-fixture.mjs";

const { Client } = pg;
const script = path.resolve("scripts/inbox-test-readonly-fixture.mjs");
const runId = `t1-real-${process.pid}`;
const receiptDir = process.env.INBOX_RO_FIXTURE_RECEIPT_DIR!;
const fixtureEnv = { ...process.env };
delete fixtureEnv.MESSAGING_PROVIDER;
const dbUrl = process.env.TEST_SUPABASE_DB_URL!;
const dataApiUrl = process.env.INBOX_RO_FIXTURE_T1_DATA_API_URL!;
const dataServiceRoleKey = process.env.INBOX_RO_FIXTURE_T1_DATA_SERVICE_ROLE_KEY!;
const db = new Client({ connectionString: dbUrl });
let receipt: { ids: { organization: string; messages: { scheduled: string; unscheduled: string } } };
let supabase: ReturnType<typeof createClient>;
const providerSend = vi.spyOn(MockMessagingProvider.prototype, "sendSms");

function runFixture(args: string[]): string {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: path.resolve("."),
    env: fixtureEnv,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function messageHashes(ids: string[]): Promise<Record<string, string>> {
  const result = await db.query(
    "select id::text, md5(row_to_json(messages)::text) as hash from public.messages where id=any($1::uuid[]) order by id",
    [ids],
  );
  return Object.fromEntries(result.rows.map(row => [row.id, row.hash]));
}

beforeAll(async () => {
  await db.connect();
  const created = JSON.parse(runFixture(["--create", "--run-id", runId, "--owner", "fixture-vitest", "--lease-seconds", "120"] ).trim().split(/\r?\n/).at(-1)!);
  receipt = JSON.parse(readFileSync(path.join(receiptDir, `lease-test-ro-fixture-${runId}.json`), "utf8"));
  expect(created.ids).toEqual(receipt.ids);
  process.env.MESSAGING_PROVIDER = "mock";
  process.env.NEXT_PUBLIC_SUPABASE_URL = dataApiUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = dataServiceRoleKey;
  process.env.TEST_SUPABASE_URL = dataApiUrl;
  process.env.TEST_SUPABASE_SERVICE_ROLE_KEY = dataServiceRoleKey;
  supabase = createClient(dataApiUrl, dataServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
});

afterAll(async () => {
  try {
    await db.query("select public.reset_tenant_tables()");
    runFixture(["--create", "--run-id", runId, "--owner", "fixture-vitest", "--lease-seconds", "120"]);
    const restored = JSON.parse(readFileSync(path.join(receiptDir, `lease-test-ro-fixture-${runId}.json`), "utf8"));
    stopOwnedHolder(restored.lock, runId);
  } finally {
    await db.end();
  }
});

describe("T1 real queued-message inertness", () => {
  it("selects neither fixture row, returns the real guarded outcomes, and sends only after the natural mutation", async () => {
    const ids = [receipt.ids.messages.scheduled, receipt.ids.messages.unscheduled];
    const before = await messageHashes(ids);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2036-10-05T15:00:00.000Z"));
    const senderInventoryDescriptor = Object.getOwnPropertyDescriptor(
      MockMessagingProvider.prototype,
      "listPurchasedNumbers",
    );
    // The fixture deliberately has no from_address. Remove the optional
    // catalog capability in this test process so the real release path can
    // reach the requested missing-fields boundary after the mutation.
    Object.defineProperty(MockMessagingProvider.prototype, "listPurchasedNumbers", {
      configurable: true,
      value: undefined,
    });
    try {
    const tick = await runSequenceTick(supabase, { budgetMs: 5_000, drainLimit: 10 });
    expect(tick.dueMessagesSelected).toBe(0);
    expect(tick.drainOutcomes).toEqual({});

    const scheduled = await releaseQueuedMessage(supabase, receipt.ids.messages.scheduled);
    expect(scheduled).toMatchObject({ status: "blocked_not_due", messageId: receipt.ids.messages.scheduled });
    const sendSource = readFileSync(path.resolve("src/lib/messaging/send.ts"), "utf8");
    expect(sendSource).not.toMatch(/from\("messages"\)\s*\.select\("id"\)\s*\.eq\("status", "queued"\)\s*;/);
    const unscheduled = await releaseQueuedMessage(supabase, receipt.ids.messages.unscheduled);
    expect(unscheduled).toMatchObject({ status: "db_error", error: "queued message missing contact/property/to_address" });
    expect(providerSend).not.toHaveBeenCalled();
    expect(await messageHashes(ids)).toEqual(before);

    const contactId = "44444444-5555-4666-8777-888888888888";
    const propertyId = "55555555-6666-4777-8888-999999999999";
    await db.query(
      "insert into public.contacts(id,org_id,first_name,last_name,phone_1,phone_1_type) values ($1,$2,'Fixture','Mutation','+15551234567','mobile')",
      [contactId, receipt.ids.organization],
    );
    await db.query(
      "insert into public.properties(id,org_id,address,state,homeowner_contact_id) values ($1,$2,'1 Fixture Way','MO',$3)",
      [propertyId, receipt.ids.organization, contactId],
    );
    await db.query(
      "update public.messages set contact_id=$1, property_id=$2, to_address='+15551234567' where id=$3",
      [contactId, propertyId, receipt.ids.messages.unscheduled],
    );
    await releaseQueuedMessage(supabase, receipt.ids.messages.unscheduled);
    expect(providerSend).toHaveBeenCalledTimes(1);
    } finally {
      if (senderInventoryDescriptor) Object.defineProperty(MockMessagingProvider.prototype, "listPurchasedNumbers", senderInventoryDescriptor);
      vi.useRealTimers();
    }
  });
});
