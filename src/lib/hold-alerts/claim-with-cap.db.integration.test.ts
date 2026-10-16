import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { MAX_DMS_PER_RECIPIENT_PER_HOUR, MAX_SMS_PER_HOUR, runHoldAlertsForOrg } from "./core";
import { createSupabaseDeliveryStore } from "./store";
import { hold, makeDeps } from "./test-support";
import type { CapBucket, DeliveryRow } from "./types";

/**
 * hold_alert_claim_with_cap on a DISPOSABLE database that has every migration (local only; runs in CI in the
 * "Search RPC, oracle and composition suites (disposable DB)" job). The cap check and the claim are one atomic
 * step under a per-bucket advisory lock, so two overlapping alert passes can never both take the last free slot.
 */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const extraClients: Client[] = [];
let orgId: string;
let userId: string;
let otherUserId: string;

const admin = () =>
  createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as LooseSupabase;

beforeAll(async () => {
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  await pg.connect();
  const { rows } = await pg.query("select to_regproc('public.hold_alert_claim_with_cap') as f");
  expect(rows[0].f, "hold_alert_claim_with_cap must exist (migration 20261016010000 missing)").toBeTruthy();
  orgId = randomUUID();
  userId = randomUUID();
  otherUserId = randomUUID();
  await pg.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `claim-cap ${orgId}`]);
  for (const id of [userId, otherUserId]) await pg.query("insert into auth.users (id, email) values ($1, $2)", [id, `cap-${id}@test.local`]);
  await pg.query("insert into public.hold_alert_settings (org_id, alerts_since) values ($1, now() - interval '1 day')", [orgId]);
}, 60_000);

afterAll(async () => {
  try {
    await pg.query("delete from public.hold_alert_deliveries where org_id = $1", [orgId]);
    await pg.query("delete from public.hold_alert_settings where org_id = $1", [orgId]);
    await pg.query("delete from public.organizations where id = $1", [orgId]);
    await pg.query("delete from auth.users where id = any($1::uuid[])", [[userId, otherUserId]]);
  } finally {
    for (const c of extraClients) await c.end().catch(() => undefined);
    await pg.end();
  }
});

const reset = () => pg.query("delete from public.hold_alert_deliveries where org_id = $1", [orgId]);

async function seedSent(channel: "sms" | "slack", n: number, recipient: string, ageMinutes: number, label = "seed") {
  await pg.query(
    `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts, sent_at)
     select $1, null, $2 || '-' || g, $3, $4, 'first', 'sent', 1, now() - ($5 || ' minutes')::interval from generate_series(1, $6::int) g`,
    [orgId, `${label}-${channel}-${recipient}-${randomUUID()}`, recipient, channel, String(ageMinutes), n],
  );
}

async function pendingRow(channel: "sms" | "slack", recipient: string, key = randomUUID()): Promise<DeliveryRow> {
  const { rows } = await pg.query(
    `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage)
     values ($1, null, $2, $3, $4, 'first') returning id, attempts`,
    [orgId, `pending-${key}`, recipient, channel],
  );
  return { id: rows[0].id, attempts: rows[0].attempts } as DeliveryRow;
}

const sinceIso = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const smsBucket = (cap = MAX_SMS_PER_HOUR): CapBucket => ({ orgId, channel: "sms", recipientUserId: null, cap, sinceIso: sinceIso() });

async function newClient(): Promise<Client> {
  const c = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
  await c.connect();
  extraClients.push(c);
  return c;
}

describe("hold_alert_claim_with_cap: two concurrent claims, one slot left", () => {
  it("via SQL on two separate connections, 10 rounds: exactly one 'claimed' and one 'capped' every time", async () => {
    const [a, b] = [await newClient(), await newClient()];
    for (let round = 0; round < 10; round += 1) {
      await reset();
      await seedSent("sms", MAX_SMS_PER_HOUR - 1, userId, 5);
      const [r1, r2] = [await pendingRow("sms", userId), await pendingRow("sms", userId)];
      const call = (c: Client, r: DeliveryRow) =>
        c.query("select public.hold_alert_claim_with_cap($1, $2, $3, 'sms', null, $4, $5) as r", [r.id, r.attempts, orgId, MAX_SMS_PER_HOUR, sinceIso()]);
      const results = await Promise.all([call(a, r1), call(b, r2)]);
      expect(results.map((x) => x.rows[0].r).sort()).toEqual(["capped", "claimed"]);
      const { rows } = await pg.query(
        "select count(*)::int as n from public.hold_alert_deliveries where org_id = $1 and channel = 'sms' and status in ('sent', 'sending')",
        [orgId],
      );
      expect(rows[0].n).toBe(MAX_SMS_PER_HOUR);
    }
  }, 60_000);

  it("via the real store (PostgREST RPC, separate HTTP connections), 10 rounds: exactly one 'claimed' and one 'capped'", async () => {
    const store = createSupabaseDeliveryStore(admin());
    for (let round = 0; round < 10; round += 1) {
      await reset();
      await seedSent("sms", MAX_SMS_PER_HOUR - 1, userId, 5);
      const [r1, r2] = [await pendingRow("sms", userId), await pendingRow("sms", userId)];
      const results = await Promise.all([store.claimWithCap(r1, smsBucket()), store.claimWithCap(r2, smsBucket())]);
      expect([...results].sort()).toEqual(["capped", "claimed"]);
      const { rows } = await pg.query(
        "select status, attempts from public.hold_alert_deliveries where id = any($1::uuid[]) order by status",
        [[r1.id, r2.id]],
      );
      expect(rows.map((r) => [r.status, r.attempts])).toEqual([["pending", 0], ["sending", 1]]);
    }
  }, 60_000);

  it("20 concurrent claims with 4 slots left: exactly 4 claimed, 16 capped", async () => {
    await reset();
    await seedSent("sms", MAX_SMS_PER_HOUR - 4, userId, 5);
    const store = createSupabaseDeliveryStore(admin());
    const rowsIn = await Promise.all(Array.from({ length: 20 }, () => pendingRow("sms", userId)));
    const results = await Promise.all(rowsIn.map((r) => store.claimWithCap(r, smsBucket())));
    expect(results.filter((x) => x === "claimed")).toHaveLength(4);
    expect(results.filter((x) => x === "capped")).toHaveLength(16);
  }, 60_000);
});

describe("hold_alert_claim_with_cap: single-call semantics", () => {
  it("'lost' when the row moved on (attempts mismatch, or already sending/sent) even with room under the cap", async () => {
    await reset();
    const store = createSupabaseDeliveryStore(admin());
    const row = await pendingRow("sms", userId);
    expect(await store.claimWithCap({ ...row, attempts: row.attempts + 1 }, smsBucket())).toBe("lost");
    expect(await store.claimWithCap(row, smsBucket())).toBe("claimed");
    expect(await store.claimWithCap(row, smsBucket())).toBe("lost");
  });

  it("a 'failed' row with matching attempts is claimable; the claim spends one attempt", async () => {
    await reset();
    const store = createSupabaseDeliveryStore(admin());
    const row = await pendingRow("sms", userId);
    await pg.query("update public.hold_alert_deliveries set status = 'failed', attempts = 1 where id = $1", [row.id]);
    expect(await store.claimWithCap({ ...row, attempts: 1 }, smsBucket())).toBe("claimed");
    const { rows } = await pg.query("select status, attempts from public.hold_alert_deliveries where id = $1", [row.id]);
    expect([rows[0].status, rows[0].attempts]).toEqual(["sending", 2]);
  });

  it("only the last hour counts: 10 SMS sent 2 hours ago leave the whole cap free; a 'sending' row counts", async () => {
    await reset();
    const store = createSupabaseDeliveryStore(admin());
    await seedSent("sms", MAX_SMS_PER_HOUR, userId, 120);
    expect(await store.claimWithCap(await pendingRow("sms", userId), smsBucket())).toBe("claimed");
    await reset();
    await seedSent("sms", MAX_SMS_PER_HOUR - 1, userId, 5);
    const inFlight = await pendingRow("sms", userId);
    await pg.query("update public.hold_alert_deliveries set status = 'sending', attempts = 1, sending_at = now() where id = $1", [inFlight.id]);
    expect(await store.claimWithCap(await pendingRow("sms", userId), smsBucket())).toBe("capped");
  });

  it("a capped claim leaves the row exactly as it was (pending, no attempt spent)", async () => {
    await reset();
    const store = createSupabaseDeliveryStore(admin());
    await seedSent("sms", MAX_SMS_PER_HOUR, userId, 5);
    const row = await pendingRow("sms", userId);
    expect(await store.claimWithCap(row, smsBucket())).toBe("capped");
    const { rows } = await pg.query("select status, attempts, sending_at from public.hold_alert_deliveries where id = $1", [row.id]);
    expect([rows[0].status, rows[0].attempts, rows[0].sending_at]).toEqual(["pending", 0, null]);
  });

  it("Slack is capped per recipient: another recipient's full DM cap do not block this one, and the bucket does not mix with SMS", async () => {
    await reset();
    const store = createSupabaseDeliveryStore(admin());
    await seedSent("slack", MAX_DMS_PER_RECIPIENT_PER_HOUR, otherUserId, 5);
    await seedSent("sms", MAX_SMS_PER_HOUR, otherUserId, 5);
    const slack = (recipient: string): CapBucket => ({ orgId, channel: "slack", recipientUserId: recipient, cap: MAX_DMS_PER_RECIPIENT_PER_HOUR, sinceIso: sinceIso() });
    expect(await store.claimWithCap(await pendingRow("slack", otherUserId), slack(otherUserId))).toBe("capped");
    expect(await store.claimWithCap(await pendingRow("slack", userId), slack(userId))).toBe("claimed");
  });

  it("another org's deliveries never count", async () => {
    await reset();
    const store = createSupabaseDeliveryStore(admin());
    const other = randomUUID();
    await pg.query("insert into public.organizations (id, name) values ($1, $2)", [other, `claim-cap other ${other}`]);
    try {
      for (let i = 0; i < MAX_SMS_PER_HOUR; i += 1) {
        await pg.query(
          `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, attempts, sent_at)
           values ($1, null, $2, $3, 'sms', 'first', 'sent', 1, now())`,
          [other, `o-${i}-${randomUUID()}`, userId],
        );
      }
      expect(await store.claimWithCap(await pendingRow("sms", userId), smsBucket())).toBe("claimed");
    } finally {
      await pg.query("delete from public.hold_alert_deliveries where org_id = $1", [other]);
      await pg.query("delete from public.organizations where id = $1", [other]);
    }
  });
});

describe("two concurrent runHoldAlertsForOrg passes with 9 SMS already sent", () => {
  it("total SMS in the hour is exactly 10, over 5 rounds (the real store and function, recording senders)", async () => {
    const store = createSupabaseDeliveryStore(admin());
    for (let round = 0; round < 5; round += 1) {
      await reset();
      await seedSent("sms", MAX_SMS_PER_HOUR - 1, userId, 5);
      const started = new Date().toISOString();
      const holds = [0, 1, 2].map((i) =>
        hold({ hot: true, holdKey: `r${round}c${i}:hot_lead`, propertyId: `r${round}c${i}`, startedAt: started }),
      );
      const make = (list: typeof holds) =>
        makeDeps({
          store: store as never,
          holds: list,
          recipients: [{ userId, role: "owner" }],
          nowIso: new Date().toISOString(),
          hotOwner: userId,
          loadPropertyAssignee: async () => userId,
        });
      const a = make(holds);
      const b = make([...holds].reverse());
      await Promise.all([runHoldAlertsForOrg(a.deps, orgId), runHoldAlertsForOrg(b.deps, orgId)]);
      const sms = [...a.sent, ...b.sent].filter((s) => s.channel === "sms");
      expect(sms).toHaveLength(1);
      const { rows } = await pg.query(
        "select count(*)::int as n from public.hold_alert_deliveries where org_id = $1 and channel = 'sms' and status in ('sent', 'sending') and coalesce(sent_at, sending_at) >= now() - interval '1 hour'",
        [orgId],
      );
      expect(rows[0].n).toBe(MAX_SMS_PER_HOUR);
      // Nothing was lost: the two refused SMS rows are still pending with no attempt spent, so a later hour delivers them.
      const pend = await pg.query(
        "select count(*)::int as n from public.hold_alert_deliveries where org_id = $1 and channel = 'sms' and status = 'pending' and attempts = 0",
        [orgId],
      );
      expect(pend.rows[0].n).toBe(2);
    }
  }, 120_000);
});
