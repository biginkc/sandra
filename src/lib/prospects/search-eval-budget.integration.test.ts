/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Evaluation-count budget (stress #7/#4): one Search page load evaluates
 * public.search_properties at most TWICE (rows + exact count, CASS breakdown
 * hidden during a global search). Measured with pg_stat_user_functions deltas
 * on the LOCAL stack (needs track_functions=all, set here via supabase_admin).
 */
import { randomUUID } from "node:crypto";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import { BMH_ORG_ID, TEST_ORG_B_ID, clientForUser, createOrgUser, seedTwoOrgs } from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";
import { assertLocalOnlyEnvironment } from "@/lib/testing/local-only-guard";

import { buildScopedQuery } from "./search-scope";

assertLocalOnlyEnvironment();
const svc = createTestClient() as any;
let userA: any;
let admin: Client;
const authUsers: string[] = [];

function adminUrl(): string {
  const u = new URL(process.env.TEST_SUPABASE_DB_URL!);
  u.username = "supabase_admin";
  u.password = "postgres";
  return u.toString();
}

async function calls(): Promise<number> {
  await new Promise((r) => setTimeout(r, 1500)); // stats flush
  const { rows } = await admin.query("select coalesce(sum(calls),0)::int as c from pg_stat_user_functions where funcname = 'search_properties'");
  return rows[0].c;
}

beforeAll(async () => {
  admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query("alter system set track_functions = 'all'");
  await admin.query("select pg_reload_conf()");
  await resetTenantTables(svc);
  await seedTwoOrgs(svc);
  const a = await createOrgUser(svc, { orgId: BMH_ORG_ID, email: `eb-${randomUUID()}@example.test`, role: "owner" });
  const b = await createOrgUser(svc, { orgId: TEST_ORG_B_ID, email: `ec-${randomUUID()}@example.test`, role: "owner" });
  authUsers.push(a.userId, b.userId);
  userA = clientForUser(a.jwt);
  const rows = Array.from({ length: 120 }, (_, i) => ({ org_id: BMH_ORG_ID, address: `${i} Budgetville Rd`, city: "Kansas City", state: "MO" }));
  const { error } = await svc.from("properties").insert(rows);
  if (error) throw new Error(error.message);
}, 180_000);

afterAll(async () => {
  for (const id of authUsers) await svc.auth.admin.deleteUser(id).catch(() => undefined);
  await resetTenantTables(svc);
  await admin?.end();
}, 120_000);

async function pageLoad(): Promise<void> {
  const { builder } = await buildScopedQuery(userA, {
    origin: "search_page", select: "id, address, created_at", selectOpts: { count: "exact" },
    search: "Budgetville", blockStack: [], includeMessages: true,
  });
  const { error, count } = await builder.order("created_at", { ascending: false }).order("id").range(0, 49);
  expect(error).toBeNull();
  expect(count).toBe(120);
}

describe("search_properties evaluation budget", () => {
  it("track_functions is on for new sessions", async () => {
    const { rows } = await admin.query("show track_functions");
    expect(rows[0].track_functions).toBe("all");
  });

  it("one page load (rows + exact count) evaluates the function at most twice", async () => {
    await pageLoad(); // warm
    const before = await calls();
    await pageLoad();
    const delta = (await calls()) - before;
    console.log(`EVAL_BUDGET page load: ${delta} evaluation(s)`);
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(2);
  });

  it("the drawer count (head + exact) evaluates it at most once", async () => {
    const before = await calls();
    const { builder } = await buildScopedQuery(userA, {
      origin: "search_page", select: "id", selectOpts: { count: "exact", head: true },
      search: "Budgetville", blockStack: [], includeMessages: true,
    });
    const { count, error } = await builder;
    expect(error).toBeNull();
    expect(count).toBe(120);
    const delta = (await calls()) - before;
    console.log(`EVAL_BUDGET head count: ${delta} evaluation(s)`);
    expect(delta).toBeLessThanOrEqual(1);
  });

  it("no-search and 1-2 char searches never evaluate the function", async () => {
    const before = await calls();
    for (const search of [null, "Bu"]) {
      const { builder } = await buildScopedQuery(userA, {
        origin: "search_page", select: "id", selectOpts: { count: "exact", head: true },
        search, blockStack: [], includeMessages: true,
      });
      const { error } = await builder;
      expect(error).toBeNull();
    }
    expect((await calls()) - before).toBe(0);
  });
});
