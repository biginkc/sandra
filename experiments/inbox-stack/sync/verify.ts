import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createCollection } from "@tanstack/db";
import { electricCollectionOptions } from "@tanstack/electric-db-collection";
import {
  pool,
  ORG_A,
  ORG_B,
  USER_A,
  assertFixtureDatabase,
} from "../shared/database.js";
import { startGateway, type TestHooks } from "./gateway.js";
const strategy =
  process.env.SYNC_STRATEGY === "explicit_ids"
    ? "explicit_ids"
    : "membership_subquery";
const size = strategy === "explicit_ids" ? 100 : 500;
const base = "http://127.0.0.1:58790";
const hooks: TestHooks = {};
const gateway = await startGateway({ port: 58790, hooks, strategy });
const results: { name: string; status: string; details?: unknown }[] = [];
const auth = { authorization: "Bearer synthetic-a" };
async function request(path: string, init: RequestInit = {}) {
  return fetch(base + path, { ...init, headers: { ...auth, ...init.headers } });
}
async function workset(limit: number) {
  const r = await request("/worksets", {
    method: "POST",
    body: JSON.stringify({ limit }),
  });
  assert.equal(r.status, 201);
  return r.json() as Promise<{ id: string; ids: string[]; shapeUrl: string }>;
}
async function remove(id: string) {
  await request("/worksets/" + id, { method: "DELETE" });
}
async function test(name: string, run: () => Promise<unknown>) {
  const details = await run();
  results.push({ name, status: "PASS", details });
  console.log("PASS", name);
}
async function until(predicate: () => boolean, ms = 10000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("condition timeout");
    await new Promise((r) => setTimeout(r, 40));
  }
}
type Summary = {
  org_id: string;
  conversation_id: string;
  property_id: string;
  last_preview: string;
  latest_message_at: string;
  outcome: string | null;
  assigned_user_id: string | null;
  revision: string;
};
let collection:
  ReturnType<typeof createCollection<Summary, string>> | undefined;
try {
  await assertFixtureDatabase();
  await test("unauthenticated rejected", async () => {
    assert.equal(
      (await fetch(base + "/worksets", { method: "POST", body: '{"limit":1}' }))
        .status,
      401,
    );
  });
  await test("scope and bounds request tamper rejected", async () => {
    for (const body of [
      { limit: 501 },
      { limit: 1, org_id: ORG_B },
      { limit: 1, where: "true" },
    ])
      assert.equal(
        (
          await request("/worksets", {
            method: "POST",
            body: JSON.stringify(body),
          })
        ).status,
        400,
      );
  });
  const w = await workset(size);
  let initial: any[] = [];
  let handle = "";
  let offset = "";
  await test("bounded base snapshot and tenant exclusion", async () => {
    const r = await request("/shape/" + w.id + "?offset=-1");
    const raw = await r.text();
    assert.equal(r.status, 200, raw.slice(0, 300));
    initial = JSON.parse(raw);
    const rows = initial.filter((m) => m.value);
    assert.equal(rows.length, size);
    assert(
      rows.every(
        (m) =>
          m.value.org_id === ORG_A && w.ids.includes(m.value.conversation_id),
      ),
    );
    handle = r.headers.get("electric-handle")!;
    offset = r.headers.get("electric-offset")!;
    assert(handle && offset);
    return {
      rows: rows.length,
      upstreamUrlBytes: gateway.stats.maxUpstreamUrlBytes,
    };
  });
  await test("cross-user workset and handle tamper rejected", async () => {
    assert.equal(
      (
        await request("/shape/" + w.id + "?offset=-1", {
          headers: { authorization: "Bearer synthetic-b" },
        })
      ).status,
      404,
    );
    assert.equal(
      (await request("/shape/" + w.id + "?offset=" + offset + "&handle=forged"))
        .status,
      403,
    );
    assert.equal(
      (await request("/shape/" + w.id + "?offset=-1&table=properties")).status,
      400,
    );
  });
  await test("direct database update delivered through resumed shape", async () => {
    const marker = "runtime-direct-" + Date.now();
    await pool.query(
      "update inbox_t1.conversation_summaries set last_preview=$1 where org_id=$2 and conversation_id=$3",
      [marker, ORG_A, w.ids[0]],
    );
    const r = await request(
      "/shape/" +
        w.id +
        "?offset=" +
        offset +
        "&handle=" +
        handle +
        "&live=true",
    );
    const body = (await r.json()) as any[];
    assert.equal(r.status, 200, JSON.stringify(body));
    assert(body.some((m) => m.value?.last_preview === marker));
    offset = r.headers.get("electric-offset")!;
    return { matched: true };
  });
  await remove(w.id);
  const small = await workset(2);
  let packets: any[] = [];
  await test("outside-ID and other-tenant updates absent from bounded shape", async () => {
    let r = await request("/shape/" + small.id + "?offset=-1");
    await r.arrayBuffer();
    const h = r.headers.get("electric-handle")!,
      o = r.headers.get("electric-offset")!;
    const outside = w.ids[10];
    await pool.query(
      "update inbox_t1.conversation_summaries set last_preview=$1 where conversation_id=$2",
      ["outside-" + Date.now(), outside],
    );
    await pool.query(
      "update inbox_t1.conversation_summaries set last_preview=$1 where org_id=$2",
      ["other-org-" + Date.now(), ORG_B],
    );
    const marker = "inside-" + Date.now();
    await pool.query(
      "update inbox_t1.conversation_summaries set last_preview=$1 where conversation_id=$2",
      [marker, small.ids[0]],
    );
    r = await request(
      "/shape/" + small.id + "?offset=" + o + "&handle=" + h + "&live=true",
    );
    packets = (await r.json()) as any[];
    assert.equal(r.status, 200);
    const changed = packets.filter((m) => m.value);
    assert(changed.some((m) => m.value.last_preview === marker));
    assert(
      changed.every(
        (m) =>
          small.ids.includes(m.value.conversation_id) &&
          m.value.org_id === ORG_A,
      ),
    );
    return { changedRows: changed.length };
  });
  await remove(small.id);
  const live = await workset(size);
  await test("TanStack actual collection snapshot and live canonical update", async () => {
    const c = createCollection(
      electricCollectionOptions<Summary>({
        id: "runtime-" + live.id,
        getKey: (r) => r.conversation_id,
        syncMode: "eager",
        shapeOptions: {
          url: live.shapeUrl,
          headers: auth,
          subscribe: true,
          onError: (e) => {
            console.error("shape error", e);
            return undefined;
          },
        },
      }),
    );
    collection = c as any;
    await c.preload();
    assert.equal(c.size, size);
    const marker = "collection-" + Date.now();
    await pool.query(
      "update inbox_t1.conversation_summaries set last_preview=$1 where conversation_id=$2",
      [marker, live.ids[1]],
    );
    await until(() => c.get(live.ids[1])?.last_preview === marker);
    return { size: c.size, matched: true };
  });
  await test("collection lifecycle reset remains bounded", async () => {
    await collection!.cleanup();
    collection = undefined;
    const c = createCollection(
      electricCollectionOptions<Summary>({
        id: "resnapshot-" + live.id,
        getKey: (r) => r.conversation_id,
        syncMode: "eager",
        shapeOptions: {
          url: live.shapeUrl,
          headers: auth,
          subscribe: true,
          onError: (e) => {
            console.error("shape error", e);
            return undefined;
          },
        },
      }),
    );
    collection = c as any;
    await c.preload();
    assert.equal(c.size, size);
    return { size: c.size, kind: "client lifecycle rebuild, not server409" };
  });
  await collection!.cleanup();
  collection = undefined;
  await test("access epoch changed before body forwarding denies entire response", async () => {
    hooks.afterBody = async () => {
      hooks.afterBody = undefined;
      await pool.query(
        "update inbox_t1.memberships set access_epoch=access_epoch+1 where org_id=$1 and user_id=$2",
        [ORG_A, USER_A],
      );
    };
    const r = await request("/shape/" + live.id + "?offset=-1");
    assert.equal(r.status, 403);
    const body = await r.json();
    assert.deepEqual(body, { error: "access_epoch_changed" });
    return { noRowsForwarded: true };
  });
  await remove(live.id);
  const revoked = await workset(1);
  await test("revoked membership denied", async () => {
    await pool.query(
      "update inbox_t1.memberships set active=false where org_id=$1 and user_id=$2",
      [ORG_A, USER_A],
    );
    assert.equal(
      (await request("/shape/" + revoked.id + "?offset=-1")).status,
      403,
    );
    await pool.query(
      "update inbox_t1.memberships set active=true where org_id=$1 and user_id=$2",
      [ORG_A, USER_A],
    );
  });
  await test("expired workset denied", async () => {
    gateway.expire(revoked.id);
    assert.equal(
      (await request("/shape/" + revoked.id + "?offset=-1")).status,
      410,
    );
  });
  await writeFile(
    new URL("./evidence-" + strategy + ".json", import.meta.url),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        status: "PASS",
        strategy,
        size,
        results,
        stats: gateway.stats,
        limits: [
          "Synthetic sessions only; not Hugo",
          "Eager collection over bounded500 IDs; on-demand runtime not tested",
          "Lifecycle resnapshot only; server409 not yet tested",
          "No production scale/browser latency claim",
        ],
      },
      null,
      2,
    ),
  );
} catch (e) {
  await writeFile(
    new URL("./evidence-" + strategy + ".json", import.meta.url),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        status: "FAIL",
        results,
        error: String(e),
        stats: gateway.stats,
      },
      null,
      2,
    ),
  );
  throw e;
} finally {
  hooks.afterBody = undefined;
  await collection?.cleanup();
  await pool.query(
    "update inbox_t1.memberships set active=true where org_id=$1 and user_id=$2",
    [ORG_A, USER_A],
  );
  await gateway.close();
  await pool.end();
}
