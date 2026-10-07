import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { runHoldAlertsForOrg } from "./core";
import { createSupabaseDeliveryStore } from "./store";
import { hold, makeDeps } from "./test-support";

/**
 * archiveClosed against a real PostgREST + Postgres (local only). Open-hold
 * rows must not fill the page window and starve closed rows behind them, and a
 * hold that re-opens after archiving must alert again. If the local database
 * has no hold_alert_deliveries table, a minimal copy is created and dropped.
 */
const db = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
let createdTable = false;
let createdRpcs = false;
let orgId: string;
let userId: string;
const LAST_ID = "ffffffff-ffff-4fff-bfff-ffffffffffff";

beforeAll(async () => {
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  await db.connect();
  const { rows } = await db.query("select to_regclass('public.hold_alert_deliveries') as t");
  if (!rows[0].t) {
    await db.query(`
      create table public.hold_alert_deliveries (
        id uuid primary key default gen_random_uuid(),
        org_id uuid not null references public.organizations(id) on delete cascade,
        property_id uuid references public.properties(id) on delete cascade,
        hold_key text not null,
        recipient_user_id uuid not null references auth.users(id) on delete cascade,
        channel text not null check (channel in ('slack', 'sms', 'email')),
        stage text not null check (stage in ('first', 'nudge_1h', 'digest')),
        status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
        attempts integer not null default 0,
        last_error text,
        created_at timestamptz not null default now(),
        sent_at timestamptz,
        sending_at timestamptz,
        constraint hold_alert_deliveries_unique_key unique (hold_key, recipient_user_id, channel, stage)
      );
      grant select, insert, update on public.hold_alert_deliveries to service_role;
    `);
    await db.query("notify pgrst, 'reload schema'");
    await new Promise((r) => setTimeout(r, 1500));
    createdTable = true;
  }
  const fnCheck = await db.query("select to_regproc('public.hold_alert_archive_rows') as f");
  if (!fnCheck.rows[0].f) {
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/20261008150300_hold_alert_delivery_rpcs.sql"),
      "utf8",
    )
      .replace(/^begin;$/m, "")
      .replace(/^commit;$/m, "");
    await db.query(sql);
    createdRpcs = true;
    await db.query("notify pgrst, 'reload schema'");
    await new Promise((r) => setTimeout(r, 1500));
  }
  orgId = randomUUID();
  userId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, $2)", [orgId, `Archive ${orgId}`]);
  await db.query("insert into auth.users (id, email) values ($1, $2)", [userId, `a-${userId}@test.local`]);
});

afterAll(async () => {
  try {
    if (createdRpcs) {
      await db.query("drop function if exists public.hold_alert_archive_rows(uuid, uuid[])");
      await db.query("drop function if exists public.hold_alert_latest_status(uuid, uuid[])");
    }
    if (createdTable) {
      await db.query("drop table if exists public.hold_alert_deliveries");
      await db.query("notify pgrst, 'reload schema'");
    } else {
      await db.query("delete from public.hold_alert_deliveries where org_id = $1", [orgId]);
    }
    await db.query("delete from public.properties where org_id = $1", [orgId]);
    await db.query("delete from public.organizations where id = $1", [orgId]);
    await db.query("delete from auth.users where id = $1", [userId]);
  } finally {
    await db.end();
  }
});

const admin = () =>
  createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as LooseSupabase;

async function newProperty(): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.properties (id, org_id, address, state, status) values ($1, $2, '1 Main St', 'MO', 'new_lead')`,
    [id, orgId],
  );
  return id;
}

describe("archiveClosed with a full window of open holds", () => {
  it("archives a closed row that sorts behind 500+ still-open rows", async () => {
    const closedProp = await newProperty();
    const openProps: string[] = [];
    for (let i = 0; i < 505; i += 1) openProps.push(await newProperty());
    await db.query(
      `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status)
       select $1, p, p::text || ':draft_held', $2, 'slack', 'first', 'sent' from unnest($3::uuid[]) as p`,
      [orgId, userId, openProps],
    );
    await db.query(
      `insert into public.hold_alert_deliveries (id, org_id, property_id, hold_key, recipient_user_id, channel, stage, status)
       values ($1, $2, $3, $4, $5, 'slack', 'first', 'sent')`,
      [LAST_ID, orgId, closedProp, `${closedProp}:draft_held`, userId],
    );

    const archived = await createSupabaseDeliveryStore(admin()).archiveClosed(orgId, openProps);
    expect(archived).toBe(1);
    const { rows } = await db.query(
      "select count(*)::int as n from public.hold_alert_deliveries where org_id = $1 and hold_key like '%:closed:%'",
      [orgId],
    );
    expect(rows[0].n).toBe(1);
    await db.query("delete from public.hold_alert_deliveries where org_id = $1", [orgId]);
  });

  it("a hold that closes and re-opens alerts again", async () => {
    const property = await newProperty();
    const store = createSupabaseDeliveryStore(admin());
    const h = hold({ propertyId: property, holdKey: `${property}:draft_held` });
    const recipient = { userId, role: "owner" as const };
    const pass = (holds: ReturnType<typeof hold>[]) => {
      const t = makeDeps({ store: store as never, holds, recipients: [recipient], nowIso: new Date().toISOString() });
      return runHoldAlertsForOrg(t.deps, orgId).then((s) => ({ s, t }));
    };

    const first = await pass([h]);
    expect(first.t.sent.filter((x) => x.channel === "slack")).toHaveLength(1);
    const again = await pass([h]);
    expect(again.t.sent).toHaveLength(0);

    const closed = await pass([]);
    expect(closed.s.archived).toBeGreaterThanOrEqual(1);

    const reopened = await pass([h]);
    expect(reopened.t.sent.filter((x) => x.channel === "slack")).toHaveLength(1);
  });
});

describe("hold_alert_latest_status", () => {
  it("returns the newest live row per property: a noisy property cannot hide a quiet one", async () => {
    const noisy = await newProperty();
    const quiet = await newProperty();
    await db.query(
      `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, last_error, created_at)
       select $1, $2::uuid, $2::text || ':k' || g, $3, 'slack', 'first', 'sent', null, now() - (g || ' minutes')::interval
       from generate_series(1, 100) g`,
      [orgId, noisy, userId],
    );
    await db.query(
      `insert into public.hold_alert_deliveries (org_id, property_id, hold_key, recipient_user_id, channel, stage, status, last_error, created_at)
       values ($1, $2::uuid, $2::text || ':quiet', $3, 'slack', 'first', 'failed', 'interrupted', now() - interval '3 days'),
              ($1, $2::uuid, $2::text || ':quiet:closed:x', $3, 'sms', 'first', 'sent', null, now())`,
      [orgId, quiet, userId],
    );
    const { data, error } = await admin().rpc("hold_alert_latest_status", {
      p_org_id: orgId,
      p_property_ids: [noisy, quiet],
    });
    expect(error).toBeNull();
    const byProp = Object.fromEntries((data as Array<{ property_id: string; status: string; last_error: string | null }>).map((r) => [r.property_id, r]));
    expect(Object.keys(byProp).sort()).toEqual([noisy, quiet].sort());
    expect(byProp[noisy]).toMatchObject({ status: "sent" });
    expect(byProp[quiet]).toMatchObject({ status: "failed", last_error: "interrupted" });
    await db.query("delete from public.hold_alert_deliveries where org_id = $1", [orgId]);
  });
});
