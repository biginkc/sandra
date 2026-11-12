import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Multi-number SMS campaigns, PR 1 (plan .planning/multi-number-campaigns-plan.md §3.2, §3.3,
 * §3.8, §5). Local-only, real Postgres. Both rollbacks run first, then the migrations are
 * re-applied over a pre-existing settings row (backfill). Every test uses its own org.
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");
const SCHEMA = read("20261112120000_multi_number_sender_schema.sql");
const RPCS = read("20261112120100_multi_number_sender_rpcs.sql");
const SCHEMA_ROLLBACK = read("../rollbacks/20261112120000_multi_number_sender_schema.sql");
const RPCS_ROLLBACK = read("../rollbacks/20261112120100_multi_number_sender_rpcs.sql");

const db = new Client({ connectionString: url });
const extraClients: Client[] = [];
const orgs: string[] = [];

const A = "+18165550101";
const B = "+18165550102";
const C = "+18165550103";
const REP = "+18165550199";

async function client(): Promise<Client> {
  const c = new Client({ connectionString: url });
  await c.connect();
  extraClients.push(c);
  return c;
}

let phoneCounter = 0;
function sellerPhone(): string {
  phoneCounter += 1;
  return `+1913${String(Date.now() % 1000).padStart(3, "0")}${String(phoneCounter).padStart(4, "0")}`;
}

async function newOrg(brand: string | null = "BMH Group"): Promise<string> {
  const id = randomUUID();
  orgs.push(id);
  await db.query("insert into public.organizations (id, name, sendillo_brand_name) values ($1, $2, $3)", [
    id,
    `multi-number ${id.slice(0, 8)}`,
    brand,
  ]);
  return id;
}

type CatalogOpts = {
  status?: string;
  messagingStatus?: string | null;
  campaign?: string | null;
  brand?: string | null;
  provider?: string;
};
async function catalog(orgId: string, phone: string, opts: CatalogOpts = {}) {
  await db.query(
    `insert into public.provider_sender_numbers
       (org_id, provider, phone_e164, status, messaging_status, attached_campaign, attached_brand)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (org_id, provider, phone_e164) do update
       set status = excluded.status, messaging_status = excluded.messaging_status,
           attached_campaign = excluded.attached_campaign, attached_brand = excluded.attached_brand`,
    [
      orgId,
      opts.provider ?? "sendillo",
      phone,
      opts.status ?? "active",
      opts.messagingStatus === undefined ? "Active" : opts.messagingStatus,
      opts.campaign === undefined ? "Kansas City Metro SMS Outreach" : opts.campaign,
      opts.brand === undefined ? "BMH Group" : opts.brand,
    ],
  );
}

async function campaign(orgId: string, primary: string, extra: string[] = []): Promise<string> {
  const id = (
    await db.query("insert into public.campaigns (org_id, name) values ($1, $2) returning id", [
      orgId,
      `c-${randomUUID().slice(0, 8)}`,
    ])
  ).rows[0].id as string;
  await db.query(
    "select public.persist_campaign_delivery_settings($1, $2, 'sendillo', $3, $3)",
    [id, orgId, primary],
  );
  if (extra.length > 0) {
    await db.query("select * from public.add_campaign_sender_numbers($1, $2)", [id, extra]);
  }
  return id;
}

type Msg = {
  direction: "inbound" | "outbound";
  from: string;
  to: string;
  status: string;
  metadata?: Record<string, unknown>;
  at?: string;
  sentAt?: string | null;
  campaignId?: string | null;
  propertyId?: string | null;
};
async function msg(orgId: string, m: Msg): Promise<string> {
  return (
    await db.query(
      `insert into public.messages
         (org_id, channel, direction, provider, from_address, to_address, body, status, metadata, created_at, sent_at, campaign_id, property_id)
       values ($1, 'sms', $2, 'sendillo', $3, $4, 'x', $5, $6, coalesce($7::timestamptz, now()), $8, $9, $10)
       returning id`,
      [
        orgId,
        m.direction,
        m.from,
        m.to,
        m.status,
        m.metadata ?? {},
        m.at ?? null,
        m.sentAt ?? null,
        m.campaignId ?? null,
        m.propertyId ?? null,
      ],
    )
  ).rows[0].id as string;
}

/** Fixture shortcut: write settings bypassing the ordering trigger (it is tested separately). */
async function forceSettings(
  orgId: string,
  s: { pinning?: boolean; allocation?: boolean; defaultSender?: string | null; paused?: boolean },
) {
  await db.query("begin");
  await db.query("set local session_replication_role = replica");
  await db.query(
    `insert into public.sms_sender_settings
       (org_id, pinning_enabled, pinning_enabled_at, allocation_enabled, default_sender_phone, admission_paused_at)
     values ($1, $2, case when $2 then now() - interval '2 hours' end, $3, $4, case when $5 then now() end)
     on conflict (org_id) do update set
       pinning_enabled = excluded.pinning_enabled, pinning_enabled_at = excluded.pinning_enabled_at,
       allocation_enabled = excluded.allocation_enabled, default_sender_phone = excluded.default_sender_phone,
       admission_paused_at = excluded.admission_paused_at`,
    [orgId, s.pinning ?? true, s.allocation ?? false, s.defaultSender === undefined ? A : s.defaultSender, s.paused ?? false],
  );
  await db.query("commit");
}

type Resolved = { sender_phone: string | null; source: string | null; status: string };
async function resolve(
  orgId: string,
  seller: string,
  opts: { campaignId?: string; allowDefault?: boolean; requested?: string; commitment?: string } = {},
  c: Client = db,
): Promise<Resolved> {
  return (
    await c.query(
      `select * from public.resolve_sms_sender(
         p_org_id => $1, p_seller_phone => $2, p_campaign_id => $3, p_allow_default => $4,
         p_requested_sender => $5, p_commitment_sender => $6)`,
      [orgId, seller, opts.campaignId ?? null, opts.allowDefault ?? false, opts.requested ?? null, opts.commitment ?? null],
    )
  ).rows[0] as Resolved;
}

async function assignment(orgId: string, seller: string) {
  return (
    await db.query(
      "select sender_phone_e164, source from public.sms_sender_assignments where org_id = $1 and seller_phone_e164 = $2",
      [orgId, seller],
    )
  ).rows[0] as { sender_phone_e164: string; source: string } | undefined;
}

/** Org with A (default + campaign primary), B and C sendable, all in the pool. */
async function poolOrg(opts: { pinning?: boolean; allocation?: boolean } = {}) {
  const orgId = await newOrg();
  for (const p of [A, B, C, REP]) await catalog(orgId, p);
  const campaignId = await campaign(orgId, A, [B, C]);
  await forceSettings(orgId, { pinning: opts.pinning ?? true, allocation: opts.allocation ?? false });
  return { orgId, campaignId };
}

const repMeta = { repSms: { assistant: "maria", actorUserId: randomUUID() } };

let backfillCampaignId = "";
let backfillOrgId = "";

beforeAll(async () => {
  await db.connect();
  await db.query(RPCS_ROLLBACK);
  await db.query(SCHEMA_ROLLBACK);
  // A campaign that already has a single sender before the migration (backfill input),
  // plus one whose stored sender is not E.164 (skipped, migration still applies).
  backfillOrgId = randomUUID();
  orgs.push(backfillOrgId);
  await db.query("insert into public.organizations (id, name) values ($1, 'mn-backfill')", [backfillOrgId]);
  backfillCampaignId = (
    await db.query("insert into public.campaigns (org_id, name) values ($1, 'bf') returning id", [backfillOrgId])
  ).rows[0].id;
  await db.query("select public.persist_campaign_delivery_settings($1, $2, 'sendillo', $3, $3)", [
    backfillCampaignId,
    backfillOrgId,
    A,
  ]);
  const odd = (
    await db.query("insert into public.campaigns (org_id, name) values ($1, 'odd') returning id", [backfillOrgId])
  ).rows[0].id;
  await db.query("select public.persist_campaign_delivery_settings($1, $2, 'sendillo', 'office line', 'office line')", [
    odd,
    backfillOrgId,
  ]);
  await db.query(
    `insert into public.provider_sender_numbers (org_id, provider, phone_e164, status, messaging_status, raw)
     values ($1, 'sendillo', $2, 'active', 'Active', $3)`,
    [backfillOrgId, A, { attachedCampaign: "Kansas City Metro SMS Outreach", attachedBrand: "BMH Group" }],
  );
  await db.query(SCHEMA);
  await db.query(RPCS);
}, 60_000);

afterAll(async () => {
  for (const c of extraClients) await c.end().catch(() => undefined);
  for (const orgId of orgs) {
    await db.query("delete from public.sms_sender_assignments where org_id = $1", [orgId]);
    await db.query("delete from public.sms_sender_settings where org_id = $1", [orgId]);
    await db.query("delete from public.messages where org_id = $1", [orgId]);
    await db.query("delete from public.campaigns where org_id = $1", [orgId]);
    await db.query("delete from public.properties where org_id = $1", [orgId]);
    await db.query("delete from public.provider_sender_numbers where org_id = $1", [orgId]);
    await db.query("delete from public.organizations where id = $1", [orgId]);
  }
  await db.end();
});

describe("migration: backfill, catalog columns, mirror trigger", () => {
  it("backfills one position-0 row per existing settings row and the catalog attachments from raw", async () => {
    const rows = (
      await db.query("select campaign_id, phone_e164, position from public.campaign_sender_numbers where org_id = $1", [
        backfillOrgId,
      ])
    ).rows;
    expect(rows).toEqual([{ campaign_id: backfillCampaignId, phone_e164: A, position: 0 }]);
    const cat = (
      await db.query("select attached_campaign, attached_brand from public.provider_sender_numbers where org_id = $1", [
        backfillOrgId,
      ])
    ).rows[0];
    expect(cat).toEqual({ attached_campaign: "Kansas City Metro SMS Outreach", attached_brand: "BMH Group" });
  });

  it("old persist RPC: unchanged save, unlocked primary change, primary := existing secondary", async () => {
    const orgId = await newOrg();
    for (const p of [A, B, C]) await catalog(orgId, p);
    const id = await campaign(orgId, A, [B]);
    const set = async () =>
      (
        await db.query(
          "select phone_e164, position from public.campaign_sender_numbers where campaign_id = $1 order by position",
          [id],
        )
      ).rows;
    expect(await set()).toEqual([
      { phone_e164: A, position: 0 },
      { phone_e164: B, position: 1 },
    ]);
    // unchanged save
    await db.query("select public.persist_campaign_delivery_settings($1, $2, 'sendillo', $3, $3)", [id, orgId, A]);
    expect(await set()).toEqual([
      { phone_e164: A, position: 0 },
      { phone_e164: B, position: 1 },
    ]);
    // unlocked primary change to a new number: old primary leaves
    await db.query("select public.persist_campaign_delivery_settings($1, $2, 'sendillo', $3, $3)", [id, orgId, C]);
    expect(await set()).toEqual([
      { phone_e164: C, position: 0 },
      { phone_e164: B, position: 1 },
    ]);
    // primary := existing secondary
    await db.query("select public.persist_campaign_delivery_settings($1, $2, 'sendillo', $3, $3)", [id, orgId, B]);
    expect(await set()).toEqual([{ phone_e164: B, position: 0 }]);
  });

  it("old app on new schema: the existing sender lock still rejects a primary change once outbound exists", async () => {
    const orgId = await newOrg();
    await catalog(orgId, A);
    const id = await campaign(orgId, A);
    await msg(orgId, { direction: "outbound", from: A, to: sellerPhone(), status: "queued", campaignId: id });
    await expect(
      db.query("select public.persist_campaign_delivery_settings($1, $2, 'sendillo', $3, $3)", [id, orgId, B]),
    ).rejects.toThrow(/locked after outbound/);
    const rows = (await db.query("select phone_e164 from public.campaign_sender_numbers where campaign_id = $1", [id]))
      .rows;
    expect(rows).toEqual([{ phone_e164: A }]);
  });

  it("API roles cannot write the new tables directly", async () => {
    const c = await client();
    await c.query("begin");
    await c.query("set local role authenticated");
    await expect(
      c.query(
        "insert into public.sms_sender_assignments (org_id, provider, seller_phone_e164, sender_phone_e164, source) values ($1, 'sendillo', '+19135550000', $2, 'admin')",
        [randomUUID(), A],
      ),
    ).rejects.toThrow(/permission denied/);
    await c.query("rollback");
    await c.query("begin");
    await c.query("set local role service_role");
    await expect(
      c.query("update public.sms_sender_assignments set sender_phone_e164 = $1", [B]),
    ).rejects.toThrow(/permission denied/);
    await c.query("rollback");
  });
});

describe("is_sendable_sender", () => {
  it("requires active, messaging Active, a real attached campaign, and the org brand", async () => {
    const orgId = await newOrg("BMH Group");
    const cases: Array<[string, CatalogOpts, boolean]> = [
      ["+18165550201", {}, true],
      ["+18165550202", { status: "inactive" }, false],
      ["+18165550203", { messagingStatus: "Inactive" }, false],
      ["+18165550204", { messagingStatus: null }, false],
      ["+18165550205", { campaign: "not assigned" }, false],
      ["+18165550206", { campaign: null }, false],
      ["+18165550207", { campaign: "  " }, false],
      ["+18165550208", { brand: "Other Brand" }, false],
      ["+18165550209", { messagingStatus: "ACTIVE", brand: "bmh group" }, true],
    ];
    for (const [phone, opts] of cases) await catalog(orgId, phone, opts);
    for (const [phone, , expected] of cases) {
      const r = await db.query("select public.is_sendable_sender($1, 'sendillo', $2) as ok", [orgId, phone]);
      expect([phone, r.rows[0].ok]).toEqual([phone, expected]);
    }
    const unknown = await db.query("select public.is_sendable_sender($1, 'sendillo', '+18165559998') as ok", [orgId]);
    expect(unknown.rows[0].ok).toBe(false);
  });

  it("skips the brand check when the org has no Sendillo brand", async () => {
    const orgId = await newOrg(null);
    await catalog(orgId, A, { brand: "Anything" });
    const r = await db.query("select public.is_sendable_sender($1, 'sendillo', $2) as ok", [orgId, A]);
    expect(r.rows[0].ok).toBe(true);
  });

  it("refuses an authenticated non-member", async () => {
    const orgId = await newOrg();
    const c = await client();
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: randomUUID(), role: "authenticated" }),
    ]);
    await expect(c.query("select public.is_sendable_sender($1, 'sendillo', $2)", [orgId, A])).rejects.toThrow(
      /not a member/,
    );
    await c.query("rollback");
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: randomUUID(), role: "authenticated" }),
    ]);
    await expect(c.query("select * from public.resolve_sms_sender($1, '+19135550001')", [orgId])).rejects.toThrow(
      /not a member/,
    );
    await c.query("rollback");
  });
});

describe("is_possibly_submitted_sms", () => {
  const check = async (status: string, metadata: unknown) =>
    (await db.query("select public.is_possibly_submitted_sms($1, $2) as v", [status, metadata])).rows[0].v as boolean;
  const pendingAt = "2026-11-10T10:00:00Z";

  it("pending and provider_unknown are possibly submitted", async () => {
    expect(await check("pending", { providerAttempt: { pendingAt } })).toBe(true);
    expect(
      await check("failed", { providerOutcome: "provider_unknown", providerAttempt: { pendingAt, terminal: true } }),
    ).toBe(true);
  });

  it("stale-recovered unknown stays possibly submitted (time never clears it)", async () => {
    const stale = {
      providerAttempt: {
        pendingAt,
        terminal: true,
        recoveredAt: "2026-11-10T10:16:00Z",
        recoveryReason: "stale_pending_provider_attempt",
      },
    };
    expect(await check("failed", stale)).toBe(true);
    expect(await check("failed", { providerAttempt: { pendingAt, terminal: true, outcome: "unknown" } })).toBe(true);
  });

  it("a later confirmed failure callback overrides the retained providerAttempt", async () => {
    // status-events clears providerOutcome but keeps providerAttempt, and records providerRejection.
    const afterCallback = {
      providerAttempt: { pendingAt, terminal: true, recoveryReason: "stale_pending_provider_attempt" },
      providerRejection: { source: "status_callback", at: "2026-11-10T11:00:00Z" },
    };
    expect(await check("failed", afterCallback)).toBe(false);
  });

  it("a definite synchronous rejection is not possibly submitted", async () => {
    expect(
      await check("failed", { providerAttempt: { pendingAt, terminal: true, outcome: "definitively_rejected" } }),
    ).toBe(false);
    expect(await check("failed", { providerAttempt: { pendingAt, terminal: true, outcome: "not_attempted" } })).toBe(
      false,
    );
  });

  it("other states are not", async () => {
    expect(await check("failed", {})).toBe(false);
    expect(await check("failed", null)).toBe(false);
    expect(await check("sent", { providerAttempt: { pendingAt } })).toBe(false);
    expect(await check("queued", {})).toBe(false);
  });
});

describe("sms_sender_settings trigger", () => {
  async function setupOrg() {
    const orgId = await newOrg();
    await catalog(orgId, A);
    await catalog(orgId, B);
    return orgId;
  }

  it("a missing row means pinning off", async () => {
    const orgId = await setupOrg();
    expect((await resolve(orgId, sellerPhone(), { allowDefault: true })).status).toBe("pinning_off");
    expect(
      (await db.query("select public.admit_sms_submission($1, $2, $3) as v", [orgId, sellerPhone(), B])).rows[0].v,
    ).toBe("ok");
  });

  it("enabling pinning needs a sendable default and a 15-minute admission pause; sets pinning_enabled_at", async () => {
    const orgId = await setupOrg();
    await expect(
      db.query("insert into public.sms_sender_settings (org_id, pinning_enabled) values ($1, true)", [orgId]),
    ).rejects.toThrow(/sendable default_sender_phone/);
    await db.query(
      "insert into public.sms_sender_settings (org_id, default_sender_phone, admission_paused_at) values ($1, $2, now())",
      [orgId, A],
    );
    await expect(
      db.query("update public.sms_sender_settings set pinning_enabled = true where org_id = $1", [orgId]),
    ).rejects.toThrow(/paused for 15 minutes/);
    await db.query(
      "update public.sms_sender_settings set admission_paused_at = now() - interval '16 minutes' where org_id = $1",
      [orgId],
    );
    await db.query("update public.sms_sender_settings set pinning_enabled = true where org_id = $1", [orgId]);
    const row = (
      await db.query("select pinning_enabled_at is not null as set from public.sms_sender_settings where org_id = $1", [
        orgId,
      ])
    ).rows[0];
    expect(row.set).toBe(true);
    // non-sendable default
    const org2 = await setupOrg();
    await db.query(
      "insert into public.sms_sender_settings (org_id, default_sender_phone, admission_paused_at) values ($1, $2, now() - interval '1 hour')",
      [org2, C],
    );
    await expect(
      db.query("update public.sms_sender_settings set pinning_enabled = true where org_id = $1", [org2]),
    ).rejects.toThrow(/sendable default_sender_phone/);
  });

  it("rejects allocation before the hour, and accepts it after", async () => {
    const orgId = await setupOrg();
    await db.query(
      "insert into public.sms_sender_settings (org_id, default_sender_phone, admission_paused_at) values ($1, $2, now() - interval '20 minutes')",
      [orgId, A],
    );
    await db.query("update public.sms_sender_settings set pinning_enabled = true where org_id = $1", [orgId]);
    await expect(
      db.query("update public.sms_sender_settings set allocation_enabled = true where org_id = $1", [orgId]),
    ).rejects.toThrow(/one hour after pinning/);
    // the caller cannot forge pinning_enabled_at
    await db.query(
      "update public.sms_sender_settings set pinning_enabled_at = now() - interval '2 hours' where org_id = $1",
      [orgId],
    );
    await expect(
      db.query("update public.sms_sender_settings set allocation_enabled = true where org_id = $1", [orgId]),
    ).rejects.toThrow(/one hour after pinning/);
    await forceSettings(orgId, { pinning: true });
    await db.query("update public.sms_sender_settings set allocation_enabled = true where org_id = $1", [orgId]);
  });

  it("rejects a default change while pinning is on", async () => {
    const orgId = await setupOrg();
    await forceSettings(orgId, { pinning: true });
    await expect(
      db.query("update public.sms_sender_settings set default_sender_phone = $2 where org_id = $1", [orgId, B]),
    ).rejects.toThrow(/cannot change while pinning/);
  });

  it("rejects pinning-off with a non-default assignment of any source (including no campaign) or allocation on", async () => {
    const orgId = await setupOrg();
    await forceSettings(orgId, { pinning: true, allocation: true });
    await expect(
      db.query("update public.sms_sender_settings set pinning_enabled = false where org_id = $1", [orgId]),
    ).rejects.toThrow(/allocation is disabled/);
    await db.query("update public.sms_sender_settings set allocation_enabled = false where org_id = $1", [orgId]);
    await db.query("select public.admin_reassign_sms_sender($1, $2, $3)", [orgId, sellerPhone(), B]);
    await expect(
      db.query("update public.sms_sender_settings set pinning_enabled = false where org_id = $1", [orgId]),
    ).rejects.toThrow(/non-default number/);
    // combined update (pinning off + allocation off) with only default assignments is fine
    const org2 = await setupOrg();
    await forceSettings(org2, { pinning: true, allocation: true });
    await db.query("select public.admin_reassign_sms_sender($1, $2, $3)", [org2, sellerPhone(), A]);
    await db.query(
      "update public.sms_sender_settings set pinning_enabled = false, allocation_enabled = false where org_id = $1",
      [org2],
    );
    const row = (
      await db.query("select pinning_enabled, pinning_enabled_at from public.sms_sender_settings where org_id = $1", [
        org2,
      ])
    ).rows[0];
    expect(row).toEqual({ pinning_enabled: false, pinning_enabled_at: null });
  });

  it("disable-pinning waits for an in-flight resolver and is then rejected if it wrote a non-default number", async () => {
    const { orgId } = await poolOrg();
    const seller = sellerPhone();
    await msg(orgId, { direction: "outbound", from: B, to: seller, status: "queued" });
    const s1 = await client();
    const s2 = await client();
    await s1.query("begin");
    const r1 = (await s1.query("select * from public.resolve_sms_sender($1, $2)", [orgId, seller])).rows[0];
    expect(r1).toMatchObject({ sender_phone: B, source: "commitment", status: "ok" });
    let settled = false;
    const disable = s2
      .query("update public.sms_sender_settings set pinning_enabled = false where org_id = $1", [orgId])
      .then(
        () => "ok",
        (e: Error) => e.message,
      )
      .finally(() => {
        settled = true;
      });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    await s1.query("commit");
    expect(await disable).toMatch(/non-default number/);
  });
});

describe("resolve_sms_sender", () => {
  it("pinning off answers pinning_off and writes nothing", async () => {
    const { orgId, campaignId } = await poolOrg({ pinning: false });
    const seller = sellerPhone();
    expect((await resolve(orgId, seller, { campaignId })).status).toBe("pinning_off");
    expect(await assignment(orgId, seller)).toBeUndefined();
  });

  it("step 1: an existing assignment wins; an unsendable one is reported, never replaced", async () => {
    const { orgId } = await poolOrg();
    const seller = sellerPhone();
    await db.query("select public.admin_reassign_sms_sender($1, $2, $3)", [orgId, seller, B]);
    await msg(orgId, { direction: "inbound", from: seller, to: C, status: "received" });
    expect(await resolve(orgId, seller, { requested: A })).toMatchObject({ sender_phone: B, status: "ok" });
    await catalog(orgId, B, { messagingStatus: "Inactive" });
    expect(await resolve(orgId, seller, { allowDefault: true })).toMatchObject({
      sender_phone: B,
      status: "assigned_sender_unavailable",
    });
    expect((await assignment(orgId, seller))?.sender_phone_e164).toBe(B);
  });

  it("evidence: newer failed row on B does not override older delivered A; inbound beats outbound", async () => {
    const { orgId } = await poolOrg();
    const s1 = sellerPhone();
    await msg(orgId, { direction: "outbound", from: A, to: s1, status: "delivered", at: "2026-11-01T10:00:00Z" });
    await msg(orgId, {
      direction: "outbound",
      from: B,
      to: s1,
      status: "failed",
      at: "2026-11-02T10:00:00Z",
      metadata: { providerAttempt: { outcome: "definitively_rejected" } },
    });
    expect(await resolve(orgId, s1)).toMatchObject({ sender_phone: A, source: "evidence_outbound", status: "ok" });

    const s2 = sellerPhone();
    await msg(orgId, { direction: "outbound", from: A, to: s2, status: "delivered", at: "2026-11-03T10:00:00Z" });
    await msg(orgId, { direction: "inbound", from: s2, to: C, status: "received", at: "2026-11-01T10:00:00Z" });
    expect(await resolve(orgId, s2)).toMatchObject({ sender_phone: C, source: "evidence_inbound" });
  });

  it("inbound on another property/contact for the same phone is found (phone-wide)", async () => {
    const { orgId } = await poolOrg();
    const seller = sellerPhone();
    const prop = (
      await db.query("insert into public.properties (org_id, address, state) values ($1, '1 Main St', 'MO') returning id", [
        orgId,
      ])
    ).rows[0].id;
    await db.query(
      `insert into public.messages (org_id, channel, direction, provider, from_address, to_address, body, status, property_id)
       values ($1, 'sms', 'inbound', 'sendillo', $2, $3, 'x', 'received', $4)`,
      [orgId, seller, B, prop],
    );
    expect(await resolve(orgId, seller)).toMatchObject({ sender_phone: B, source: "evidence_inbound" });
    await db.query("delete from public.messages where property_id = $1", [prop]);
    await db.query("delete from public.properties where id = $1", [prop]);
  });

  it("evidence on a non-sendable or non-pool number is ignored", async () => {
    const { orgId, campaignId } = await poolOrg();
    const seller = sellerPhone();
    const other = "+18165550177"; // sendable but in no campaign and not the default
    await catalog(orgId, other);
    await msg(orgId, { direction: "inbound", from: seller, to: other, status: "received" });
    await catalog(orgId, C, { campaign: "not assigned" });
    await msg(orgId, { direction: "outbound", from: C, to: seller, status: "delivered" });
    const r = await resolve(orgId, seller, { campaignId });
    expect(r).toMatchObject({ sender_phone: A, source: "campaign" });
  });

  it("queued-only commitment; two outstanding numbers = unresolved conflict, nothing written", async () => {
    const { orgId } = await poolOrg();
    const s1 = sellerPhone();
    await msg(orgId, { direction: "outbound", from: B, to: s1, status: "queued" });
    expect(await resolve(orgId, s1, { allowDefault: true })).toMatchObject({
      sender_phone: B,
      source: "commitment",
      status: "ok",
    });
    const s2 = sellerPhone();
    await msg(orgId, { direction: "outbound", from: B, to: s2, status: "paused" });
    await msg(orgId, { direction: "outbound", from: C, to: s2, status: "pending" });
    expect(await resolve(orgId, s2, { allowDefault: true })).toMatchObject({ status: "sender_conflict_unresolved" });
    expect(await assignment(orgId, s2)).toBeUndefined();
    const s3 = sellerPhone();
    await msg(orgId, { direction: "outbound", from: B, to: s3, status: "queued" });
    expect(await resolve(orgId, s3, { commitment: C })).toMatchObject({ status: "sender_conflict_unresolved" });
  });

  it("a stale-recovered possibly-submitted send on B is a commitment; a rejected one is not", async () => {
    const { orgId, campaignId } = await poolOrg();
    const s1 = sellerPhone();
    await msg(orgId, {
      direction: "outbound",
      from: B,
      to: s1,
      status: "failed",
      metadata: { providerAttempt: { terminal: true, recoveryReason: "stale_pending_provider_attempt" } },
    });
    expect(await resolve(orgId, s1, { campaignId })).toMatchObject({ sender_phone: B, source: "commitment" });
    const s2 = sellerPhone();
    await msg(orgId, {
      direction: "outbound",
      from: B,
      to: s2,
      status: "failed",
      metadata: {
        providerAttempt: { terminal: true, recoveryReason: "stale_pending_provider_attempt" },
        providerRejection: { source: "status_callback" },
      },
    });
    expect(await resolve(orgId, s2, { campaignId })).toMatchObject({ sender_phone: A, source: "campaign" });
  });

  it("allocation off → primary only (and only when it is the default); all paused → no number, no default, no write", async () => {
    const { orgId, campaignId } = await poolOrg();
    for (let i = 0; i < 10; i++) {
      expect(await resolve(orgId, sellerPhone(), { campaignId })).toMatchObject({ sender_phone: A, source: "campaign" });
    }
    const other = await campaign(orgId, B, [A]);
    const seller = sellerPhone();
    expect(await resolve(orgId, seller, { campaignId: other, allowDefault: true })).toMatchObject({
      status: "campaign_has_no_sendable_number",
    });
    expect(await assignment(orgId, seller)).toBeUndefined();

    await forceSettings(orgId, { pinning: true, allocation: true });
    for (const p of [A, B, C]) await db.query("select public.set_campaign_sender_paused($1, $2, true)", [campaignId, p]);
    const s2 = sellerPhone();
    expect(await resolve(orgId, s2, { campaignId, allowDefault: true })).toMatchObject({
      status: "campaign_has_no_sendable_number",
    });
    expect(await assignment(orgId, s2)).toBeUndefined();
  });

  it("allocation splits within ±5% over 10k phones", async () => {
    const { orgId, campaignId } = await poolOrg({ allocation: true });
    await db.query(
      `select count(*) from generate_series(1, 10000) g,
         lateral public.resolve_sms_sender($1, '+1660' || lpad(g::text, 7, '0'), $2) r`,
      [orgId, campaignId],
    );
    const rows = (
      await db.query(
        "select sender_phone_e164 as p, count(*)::int as n from public.sms_sender_assignments where org_id = $1 and source = 'campaign' group by 1",
        [orgId],
      )
    ).rows as Array<{ p: string; n: number }>;
    expect(rows.map((r) => r.p).sort()).toEqual([A, B, C]);
    for (const r of rows) {
      expect(Math.abs(r.n - 10000 / 3) / (10000 / 3)).toBeLessThan(0.05);
    }
  }, 120_000);

  it("requested sender: pool default → user_pick; non-default while allocation off → not sendable", async () => {
    const { orgId } = await poolOrg();
    const s1 = sellerPhone();
    expect(await resolve(orgId, s1, { requested: A })).toMatchObject({ sender_phone: A, source: "user_pick" });
    const s2 = sellerPhone();
    expect(await resolve(orgId, s2, { requested: B })).toMatchObject({ status: "requested_sender_not_sendable" });
    expect(await assignment(orgId, s2)).toBeUndefined();
    await forceSettings(orgId, { pinning: true, allocation: true });
    expect(await resolve(orgId, s2, { requested: B })).toMatchObject({ sender_phone: B, source: "user_pick" });
  });

  it("default and no_sender", async () => {
    const { orgId } = await poolOrg();
    expect(await resolve(orgId, sellerPhone(), { allowDefault: true })).toMatchObject({
      sender_phone: A,
      source: "default",
    });
    expect(await resolve(orgId, sellerPhone())).toMatchObject({ status: "no_sender" });
  });

  it("rep traffic: campaign A + newer rep SMS on B → A", async () => {
    const { orgId } = await poolOrg();
    const seller = sellerPhone();
    await msg(orgId, { direction: "outbound", from: A, to: seller, status: "delivered", at: "2026-11-01T10:00:00Z" });
    await msg(orgId, {
      direction: "outbound",
      from: B,
      to: seller,
      status: "delivered",
      at: "2026-11-02T10:00:00Z",
      metadata: repMeta,
    });
    expect(await resolve(orgId, seller)).toMatchObject({ sender_phone: A, source: "evidence_outbound" });
  });

  it("rep-only history on B, then first campaign → allocated from the campaign set; inbound to the rep number is not evidence", async () => {
    const { orgId } = await poolOrg();
    const camp = await campaign(orgId, A, [C]);
    const seller = sellerPhone();
    await msg(orgId, {
      direction: "outbound",
      from: REP,
      to: seller,
      status: "sent",
      at: "2026-11-01T10:00:00Z",
      metadata: repMeta,
    });
    await msg(orgId, { direction: "inbound", from: seller, to: REP, status: "received", at: "2026-11-01T11:00:00Z" });
    expect(await resolve(orgId, seller, { campaignId: camp })).toMatchObject({ sender_phone: A, source: "campaign" });
  });

  it("campaign A → rep SMS on B → seller replies to B (B in the pool) → A", async () => {
    const { orgId } = await poolOrg();
    const seller = sellerPhone();
    await msg(orgId, { direction: "outbound", from: A, to: seller, status: "delivered", at: "2026-11-01T10:00:00Z" });
    await msg(orgId, {
      direction: "outbound",
      from: B,
      to: seller,
      status: "sent",
      at: "2026-11-02T10:00:00Z",
      sentAt: "2026-11-02T10:00:00Z",
      metadata: repMeta,
    });
    await msg(orgId, { direction: "inbound", from: seller, to: B, status: "received", at: "2026-11-02T11:00:00Z" });
    expect(await resolve(orgId, seller)).toMatchObject({ sender_phone: A, source: "evidence_outbound" });
  });

  it("delivered A → sent rep B → queued ordinary B → inbound B: rep ownership holds, evidence is A", async () => {
    const { orgId } = await poolOrg();
    const seller = sellerPhone();
    await msg(orgId, { direction: "outbound", from: A, to: seller, status: "delivered", at: "2026-11-01T10:00:00Z" });
    await msg(orgId, {
      direction: "outbound",
      from: B,
      to: seller,
      status: "sent",
      at: "2026-11-02T10:00:00Z",
      metadata: repMeta,
    });
    await msg(orgId, { direction: "outbound", from: B, to: seller, status: "queued", at: "2026-11-02T10:30:00Z" });
    await msg(orgId, { direction: "inbound", from: seller, to: B, status: "received", at: "2026-11-02T11:00:00Z" });
    expect(await resolve(orgId, seller)).toMatchObject({ sender_phone: A, source: "evidence_outbound" });
  });

  it("an ordinary sent outbound on B after the rep row makes a later inbound on B evidence again", async () => {
    const { orgId } = await poolOrg();
    const seller = sellerPhone();
    await msg(orgId, {
      direction: "outbound",
      from: B,
      to: seller,
      status: "sent",
      at: "2026-11-02T10:00:00Z",
      metadata: repMeta,
    });
    await msg(orgId, { direction: "outbound", from: B, to: seller, status: "sent", at: "2026-11-02T10:30:00Z" });
    await msg(orgId, { direction: "inbound", from: seller, to: B, status: "received", at: "2026-11-02T11:00:00Z" });
    expect(await resolve(orgId, seller)).toMatchObject({ sender_phone: B, source: "evidence_inbound" });
  });

  it("50 concurrent resolves for one phone → one row, one number", async () => {
    const { orgId, campaignId } = await poolOrg({ allocation: true });
    const seller = sellerPhone();
    const clients = await Promise.all(Array.from({ length: 50 }, () => client()));
    const results = await Promise.all(
      clients.map((c, i) =>
        resolve(orgId, seller, i % 2 === 0 ? { campaignId } : { allowDefault: true, requested: i % 3 === 0 ? A : undefined }, c),
      ),
    );
    const senders = new Set(results.map((r) => r.sender_phone));
    expect(senders.size).toBe(1);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    const n = (
      await db.query("select count(*)::int as n from public.sms_sender_assignments where org_id = $1 and seller_phone_e164 = $2", [
        orgId,
        seller,
      ])
    ).rows[0].n;
    expect(n).toBe(1);
    for (const c of clients) await c.end();
    extraClients.splice(0, extraClients.length, ...extraClients.filter((c) => !clients.includes(c)));
  }, 60_000);

  it("composer-vs-campaign first-contact race: whoever takes the seller lock first wins, the other gets that row", async () => {
    const { orgId, campaignId } = await poolOrg();
    const s1 = await client();
    const s2 = await client();
    const seller = sellerPhone();
    await s1.query("begin");
    const first = (await s1.query("select * from public.resolve_sms_sender($1, $2, $3)", [orgId, seller, campaignId]))
      .rows[0];
    const second = s2.query("select * from public.resolve_sms_sender($1, $2, null, false, $3)", [orgId, seller, A]);
    await new Promise((r) => setTimeout(r, 200));
    await s1.query("commit");
    const r2 = (await second).rows[0];
    expect(first).toMatchObject({ sender_phone: A, source: "campaign" });
    expect(r2).toMatchObject({ sender_phone: A, source: "campaign", status: "ok" });
  });

  it("pause racing allocation never allocates the paused number", async () => {
    const { orgId, campaignId } = await poolOrg({ allocation: true });
    // a seller that would hash onto B
    let seller = "";
    for (let i = 0; i < 500 && !seller; i++) {
      const candidate = sellerPhone();
      const pick = (
        await db.query("select (array[$2,$3,$4])[1 + (((hashtextextended($1, 0) % 3) + 3) % 3)::int] as p", [
          candidate,
          A,
          B,
          C,
        ])
      ).rows[0].p;
      if (pick === B) seller = candidate;
    }
    expect(seller).not.toBe("");
    const s1 = await client();
    const s2 = await client();
    await s1.query("begin");
    await s1.query("select public.set_campaign_sender_paused($1, $2, true)", [campaignId, B]);
    const racing = s2.query("select * from public.resolve_sms_sender($1, $2, $3)", [orgId, seller, campaignId]);
    await new Promise((r) => setTimeout(r, 200));
    await s1.query("commit");
    const r = (await racing).rows[0];
    expect(r.status).toBe("ok");
    expect(r.sender_phone).not.toBe(B);
  });
});

describe("admit_sms_submission", () => {
  const admit = async (orgId: string, seller: string, from: string, c: Client = db) =>
    (await c.query("select public.admit_sms_submission($1, $2, $3) as v", [orgId, seller, from])).rows[0].v as string;

  it("paused during admission pause; ok with pinning off", async () => {
    const { orgId } = await poolOrg({ pinning: false });
    expect(await admit(orgId, sellerPhone(), B)).toBe("ok");
    await forceSettings(orgId, { pinning: false, paused: true });
    expect(await admit(orgId, sellerPhone(), B)).toBe("paused");
    await forceSettings(orgId, { pinning: true, paused: true });
    expect(await admit(orgId, sellerPhone(), A)).toBe("paused");
  });

  it("pinning on: equal → ok, different → conflict, none → adopt a pool number as commitment", async () => {
    const { orgId } = await poolOrg();
    const s1 = sellerPhone();
    await db.query("select public.admin_reassign_sms_sender($1, $2, $3)", [orgId, s1, A]);
    expect(await admit(orgId, s1, A)).toBe("ok");
    expect(await admit(orgId, s1, B)).toBe("conflict");

    const s2 = sellerPhone();
    expect(await admit(orgId, s2, B)).toBe("ok");
    expect(await assignment(orgId, s2)).toEqual({ sender_phone_e164: B, source: "commitment" });

    const s3 = sellerPhone();
    expect(await admit(orgId, s3, "+18165550155")).toBe("conflict");
    expect(await assignment(orgId, s3)).toBeUndefined();

    const s4 = sellerPhone();
    await msg(orgId, { direction: "outbound", from: A, to: s4, status: "delivered" });
    expect(await admit(orgId, s4, B)).toBe("conflict");
    expect(await assignment(orgId, s4)).toEqual({ sender_phone_e164: A, source: "evidence_outbound" });
  });
});

describe("preview, adoption, admin, KPIs, number set", () => {
  it("preview lists mismatches and multi-number sellers; adoption writes evidence/commitments only", async () => {
    const { orgId } = await poolOrg();
    const sEvidence = sellerPhone();
    await msg(orgId, { direction: "outbound", from: A, to: sEvidence, status: "delivered", at: "2026-11-01T10:00:00Z" });
    const mismatched = await msg(orgId, { direction: "outbound", from: B, to: sEvidence, status: "queued" });
    const sUnknown = sellerPhone();
    await msg(orgId, { direction: "outbound", from: A, to: sUnknown, status: "delivered", at: "2026-11-01T10:00:00Z" });
    const unknown = await msg(orgId, {
      direction: "outbound",
      from: B,
      to: sUnknown,
      status: "failed",
      metadata: { providerOutcome: "provider_unknown", providerAttempt: { terminal: true } },
    });
    const sMulti = sellerPhone();
    await msg(orgId, { direction: "outbound", from: B, to: sMulti, status: "queued" });
    await msg(orgId, { direction: "outbound", from: C, to: sMulti, status: "paused" });
    const sClean = sellerPhone();
    await msg(orgId, { direction: "outbound", from: B, to: sClean, status: "queued" });

    const rows = (await db.query("select * from public.preview_sms_sender_conflicts($1)", [orgId])).rows as Array<{
      kind: string;
      seller_phone: string;
      message_id: string | null;
    }>;
    expect(rows.find((r) => r.message_id === mismatched)?.kind).toBe("outstanding_sender_mismatch");
    expect(rows.find((r) => r.message_id === unknown)?.kind).toBe("possibly_submitted_mismatch");
    expect(rows.some((r) => r.kind === "multiple_outstanding_numbers" && r.seller_phone === sMulti)).toBe(true);
    expect(rows.some((r) => r.seller_phone === sClean)).toBe(false);
    expect(
      (await db.query("select count(*)::int as n from public.sms_sender_assignments where org_id = $1", [orgId])).rows[0].n,
    ).toBe(0);

    const adopted = (await db.query("select * from public.adopt_sms_sender_assignments($1, null, 100)", [orgId]))
      .rows as Array<{ seller_phone: string; sender_phone: string | null; status: string }>;
    const bySeller = new Map(adopted.map((r) => [r.seller_phone, r]));
    expect(bySeller.get(sEvidence)).toMatchObject({ sender_phone: A, status: "ok" });
    expect(bySeller.get(sMulti)).toMatchObject({ status: "sender_conflict_unresolved" });
    expect(bySeller.get(sClean)).toMatchObject({ sender_phone: B, status: "ok" });
    expect(await assignment(orgId, sClean)).toEqual({ sender_phone_e164: B, source: "commitment" });
    // keyset paging
    const sorted = [...bySeller.keys()].sort();
    const page = (await db.query("select * from public.adopt_sms_sender_assignments($1, $2, 100)", [orgId, sorted[1]]))
      .rows as Array<{ seller_phone: string }>;
    expect(page.every((r) => r.seller_phone > sorted[1])).toBe(true);
  });

  it("add_campaign_sender_numbers appends sendable numbers only, never removes, max 49", async () => {
    const orgId = await newOrg();
    await catalog(orgId, A);
    await catalog(orgId, B, { campaign: "not assigned" });
    const camp = await campaign(orgId, A);
    await expect(db.query("select * from public.add_campaign_sender_numbers($1, $2)", [camp, [B]])).rejects.toThrow(
      /not sendable/,
    );
    const many = Array.from({ length: 49 }, (_, i) => `+1816551${String(i).padStart(4, "0")}`);
    for (const p of many) await catalog(orgId, p);
    await db.query("select * from public.add_campaign_sender_numbers($1, $2)", [camp, many.slice(0, 48)]);
    await db.query("select * from public.add_campaign_sender_numbers($1, $2)", [camp, [A, many[0]]]); // idempotent
    await expect(
      db.query("select * from public.add_campaign_sender_numbers($1, $2)", [camp, [many[48]]]),
    ).rejects.toThrow(/at most 49/);
    const n = (await db.query("select count(*)::int as n from public.campaign_sender_numbers where campaign_id = $1", [camp]))
      .rows[0].n;
    expect(n).toBe(49);
  });

  it("campaign_kpis_by_sender counts per number", async () => {
    const orgId = await newOrg();
    await catalog(orgId, A);
    const camp = await campaign(orgId, A);
    const s1 = sellerPhone();
    const s2 = sellerPhone();
    const [p1, p2] = await Promise.all(
      ["1 A St", "2 B St"].map(
        async (address) =>
          (
            await db.query("insert into public.properties (org_id, address, state) values ($1, $2, 'MO') returning id", [
              orgId,
              address,
            ])
          ).rows[0].id as string,
      ),
    );
    await msg(orgId, {
      direction: "outbound",
      from: A,
      to: s1,
      status: "delivered",
      campaignId: camp,
      propertyId: p1,
      at: "2026-11-01T10:00:00Z",
    });
    await msg(orgId, {
      direction: "outbound",
      from: A,
      to: s2,
      status: "sent",
      campaignId: camp,
      propertyId: p2,
      sentAt: "2026-11-01T10:00:00Z",
    });
    await msg(orgId, { direction: "inbound", from: s1, to: A, status: "received", at: "2026-11-01T12:00:00Z" });
    const rows = (await db.query("select * from public.campaign_kpis_by_sender($1)", [camp])).rows;
    expect(rows).toEqual([
      {
        from_address: A,
        queued: "0",
        sent_total: "2",
        delivered: "1",
        failed: "0",
        sent_no_receipt: "1",
        repliers: "1",
      },
    ]);
  });
});

describe("evidence query plans", () => {
  it("the phone-wide evidence lookups can use the new indexes", async () => {
    const plan = async (sql: string) => {
      await db.query("begin");
      await db.query("set local enable_seqscan = off");
      const r = await db.query(`explain ${sql}`, [randomUUID(), "+19135550000"]);
      await db.query("rollback");
      return r.rows.map((row) => row["QUERY PLAN"]).join("\n");
    };
    expect(
      await plan(
        "select id from public.messages where org_id = $1 and direction = 'inbound' and channel = 'sms' and from_address = $2 order by created_at desc, id desc limit 1",
      ),
    ).toContain("idx_messages_org_from_sms_inbound_created");
    expect(
      await plan(
        "select id from public.messages where org_id = $1 and direction = 'outbound' and channel = 'sms' and to_address = $2 and status in ('sent','delivered') order by created_at desc, id desc limit 1",
      ),
    ).toContain("idx_messages_org_to_sms_outbound_created");
  });
});
