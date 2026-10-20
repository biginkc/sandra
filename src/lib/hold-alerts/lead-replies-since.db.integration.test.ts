import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LooseSupabase } from "@/app/(dashboard)/messages-v2/queries";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { createSupabaseDeliveryStore } from "./store";

/**
 * hold_alert_settings.lead_replies_since (migration 20261020120000) through the real
 * store on a DISPOSABLE database: set once by the first pass, never moved after,
 * and two concurrent first passes set it only once.
 */
const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const orgIds: string[] = [];

const admin = () =>
  createClient(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as LooseSupabase;

async function newOrg(): Promise<string> {
  const id = randomUUID();
  orgIds.push(id);
  await pg.query("insert into public.organizations (id, name) values ($1, $2)", [id, `lead-replies ${id}`]);
  await pg.query("insert into public.hold_alert_settings (org_id, alerts_since) values ($1, now() - interval '1 day')", [id]);
  return id;
}

beforeAll(async () => {
  assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
  await pg.connect();
}, 60_000);

afterAll(async () => {
  try {
    await pg.query("delete from public.hold_alert_settings where org_id = any($1::uuid[])", [orgIds]);
    await pg.query("delete from public.organizations where id = any($1::uuid[])", [orgIds]);
  } finally {
    await pg.end();
  }
});

describe("getOrInitLeadRepliesSince (real store)", () => {
  it("the first call sets it; a later call returns the same value", async () => {
    const org = await newOrg();
    const store = createSupabaseDeliveryStore(admin());
    const first = await store.getOrInitLeadRepliesSince(org, "2026-10-21T10:00:00.000Z");
    expect(Date.parse(first)).toBe(Date.parse("2026-10-21T10:00:00.000Z"));
    const second = await store.getOrInitLeadRepliesSince(org, "2026-10-22T10:00:00.000Z");
    expect(Date.parse(second)).toBe(Date.parse(first));
    const { rows } = await pg.query("select lead_replies_since from public.hold_alert_settings where org_id = $1", [org]);
    expect((rows[0].lead_replies_since as Date).toISOString()).toBe("2026-10-21T10:00:00.000Z");
  });

  it("two concurrent first calls set it only once and both see the same value", async () => {
    const org = await newOrg();
    const [a, b] = await Promise.all([
      createSupabaseDeliveryStore(admin()).getOrInitLeadRepliesSince(org, "2026-10-21T10:00:00.000Z"),
      createSupabaseDeliveryStore(admin()).getOrInitLeadRepliesSince(org, "2026-10-21T11:00:00.000Z"),
    ]);
    expect(Date.parse(a)).toBe(Date.parse(b));
    expect(["2026-10-21T10:00:00.000Z", "2026-10-21T11:00:00.000Z"]).toContain(new Date(a).toISOString());
  });
});
