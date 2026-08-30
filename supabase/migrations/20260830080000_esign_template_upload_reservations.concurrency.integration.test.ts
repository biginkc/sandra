import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const env = loadTestEnv();
const sourceUrl = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
let setup: Client;
let first: Client;
let second: Client;
let orgId = "";
let ownerId = "";
let otherOrgId = "";
let otherOwnerId = "";

function isolatedUrl(): string {
  if (!sourceUrl) throw new Error("TEST_SUPABASE_DB_URL is required");
  const url = new URL(sourceUrl);
  if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
    throw new Error("Forward-migration contention tests require isolated local PostgreSQL.");
  }
  return url.toString();
}

async function setServiceRole(client: Client): Promise<void> {
  await client.query("set role service_role");
  await client.query(
    "select set_config('request.jwt.claim.role','service_role',false)",
  );
}

async function seedVerifiedSource(
  targetOrgId = orgId,
  actorId = ownerId,
): Promise<{ id: string; path: string }> {
  const id = crypto.randomUUID();
  const path = `${targetOrgId}/${id}.pdf`;
  await setup.query(
    `select * from public.prepare_esign_template_source_upload(
       $1,$2,'race.pdf',1024,'application/pdf',repeat('e',64),$3
     )`,
    [targetOrgId, id, actorId],
  );
  await setup.query(
    `insert into storage.objects(bucket_id,name,metadata)
     values ('esign-staging',$1,jsonb_build_object(
       'mimetype','application/pdf','size',1024
     ))`,
    [path],
  );
  await setup.query(
    `select * from public.verify_esign_template_source_upload(
       $1,$2,$3,1024,'application/pdf',repeat('e',64),$4
     )`,
    [targetOrgId, id, path, actorId],
  );
  return { id, path };
}

async function consume(
  sourceId: string,
  targetOrgId = orgId,
  actorId = ownerId,
): Promise<string> {
  const result = await setup.query<{ template_id: string }>(
    `select * from public.consume_esign_template_source_draft(
       $1,$2,'Race agreement','purchase_agreement','Seller',
       '[{"name":"Seller","order":0}]'::jsonb,$3
     )`,
    [targetOrgId, sourceId, actorId],
  );
  return result.rows[0].template_id;
}

beforeAll(async () => {
  const url = isolatedUrl();
  setup = new Client({ connectionString: url });
  first = new Client({ connectionString: url });
  second = new Client({ connectionString: url });
  await Promise.all([setup.connect(), first.connect(), second.connect()]);
  orgId = crypto.randomUUID();
  ownerId = crypto.randomUUID();
  otherOrgId = crypto.randomUUID();
  otherOwnerId = crypto.randomUUID();
  await setup.query("insert into auth.users(id) values ($1),($2)", [
    ownerId,
    otherOwnerId,
  ]);
  await setup.query(
    `insert into public.organizations(id,name)
     values ($1,'Forward concurrency A'),($2,'Forward concurrency B')`,
    [orgId, otherOrgId],
  );
  await setup.query(
    `insert into public.memberships(user_id,org_id,role)
     values ($1,$2,'owner'),($3,$4,'owner')`,
    [ownerId, orgId, otherOwnerId, otherOrgId],
  );
  await Promise.all([
    setServiceRole(setup),
    setServiceRole(first),
    setServiceRole(second),
  ]);
  await setup.query(
    `select public.upsert_org_esign_integration(
       $1,'test-api-key-1234','1234','test-client','race-account',
       repeat('f',64),$2,'test-encryption-key'
     )`,
    [orgId, ownerId],
  );
  await setup.query(
    `select public.upsert_org_esign_integration(
       $1,'test-api-key-5678','5678','test-client','race-account',
       repeat('e',64),$2,'test-encryption-key'
     )`,
    [otherOrgId, otherOwnerId],
  );
}, 30_000);

afterAll(async () => {
  if (setup) {
    await setup.query("reset role");
    await setup.query("delete from public.esign_templates where org_id=any($1::uuid[])", [
      [orgId, otherOrgId],
    ]);
    await setup.query(
      "delete from public.esign_template_staging_sources where org_id=any($1::uuid[])",
      [[orgId, otherOrgId]],
    );
    await setup.query("select set_config('storage.allow_delete_query','true',false)");
    try {
      await setup.query(
        "delete from storage.objects where name like $1 or name like $2",
        [`${orgId}/%`, `${otherOrgId}/%`],
      );
    } finally {
      await setup.query("select set_config('storage.allow_delete_query','false',false)");
    }
    const consumer = await setup.query<{ callback_consumer_id: string }>(
      "select callback_consumer_id from public.org_esign_integrations where org_id=any($1::uuid[])",
      [[orgId, otherOrgId]],
    );
    await setup.query(
      "delete from public.org_esign_integrations where org_id=any($1::uuid[])",
      [[orgId, otherOrgId]],
    );
    for (const row of consumer.rows) {
      await setup.query("delete from public.webhook_consumers where id=$1", [
        row.callback_consumer_id,
      ]);
    }
    await setup.query(
      "alter table public.memberships disable trigger trg_hugo_membership_owner_guard",
    );
    try {
    await setup.query("delete from public.memberships where org_id=any($1::uuid[])", [
      [orgId, otherOrgId],
    ]);
    } finally {
      await setup.query(
        "alter table public.memberships enable trigger trg_hugo_membership_owner_guard",
      );
    }
    await setup.query("delete from public.organizations where id=any($1::uuid[])", [
      [orgId, otherOrgId],
    ]);
    await setup.query("delete from auth.users where id=any($1::uuid[])", [
      [ownerId, otherOwnerId],
    ]);
  }
  await Promise.all([setup?.end(), first?.end(), second?.end()]);
});

describe("Migration 20260830080000 — reservation contention", () => {
  it("allows exactly one cleanup claim or draft consume", async () => {
    const source = await seedVerifiedSource();
    const [cleanup, draft] = await Promise.allSettled([
      first.query(
        "select * from public.claim_unattached_esign_template_source_cleanup($1,$2,$3,$4)",
        [orgId, source.id, source.path, ownerId],
      ),
      second.query(
        `select * from public.consume_esign_template_source_draft(
           $1,$2,'Race consume','purchase_agreement','Seller',
           '[{"name":"Seller","order":0}]'::jsonb,$3
         )`,
        [orgId, source.id, ownerId],
      ),
    ]);
    expect([cleanup.status, draft.status].sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const state = await setup.query<{ cleanup_outcome: string; attached: boolean }>(
      `select source.cleanup_outcome,
         exists(select 1 from public.esign_templates template
                where template.staging_source_id=source.id) attached
       from public.esign_template_staging_sources source where source.id=$1`,
      [source.id],
    );
    expect(
      (state.rows[0].cleanup_outcome === "in_progress") !== state.rows[0].attached,
    ).toBe(true);
  });

  it("mints one provider-create token and never exposes it to the loser", async () => {
    const source = await seedVerifiedSource();
    const templateId = await consume(source.id);
    const results = await Promise.all([
      first.query<{ outcome: string; claim_token: string | null }>(
        "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
        [orgId, templateId, source.id, ownerId],
      ),
      second.query<{ outcome: string; claim_token: string | null }>(
        "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
        [orgId, templateId, source.id, ownerId],
      ),
    ]);
    const rows = results.map((result) => result.rows[0]);
    expect(rows.filter((row) => row.outcome === "claimed")).toHaveLength(1);
    expect(rows.filter((row) => row.outcome === "already_in_progress")).toHaveLength(1);
    expect(
      rows.find((row) => row.outcome === "already_in_progress")?.claim_token,
    ).toBeNull();
  });

  it("serializes exact-expiry reclaim against begin and invalidates stale tokens", async () => {
    const source = await seedVerifiedSource();
    const templateId = await consume(source.id);
    const original = await setup.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, templateId, source.id, ownerId],
    );
    const oldToken = original.rows[0].claim_token;
    await setup.query(
      `update public.esign_templates
       set provider_create_claimed_at=clock_timestamp()-interval '10 minutes'
       where id=$1`,
      [templateId],
    );
    const [begin, reclaim] = await Promise.allSettled([
      first.query<{ outcome: string }>(
        "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
        [orgId, templateId, source.id, oldToken, ownerId],
      ),
      second.query<{ outcome: string; claim_token: string | null }>(
        "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
        [orgId, templateId, source.id, ownerId],
      ),
    ]);
    const state = await setup.query<{
      provider_create_state: string;
      old_token_matches: boolean;
    }>(
      `select provider_create_state,
         provider_create_claim_token_hash = encode(
           extensions.digest(convert_to($2::uuid::text,'utf8'),'sha256'),
           'hex'
         ) old_token_matches
       from public.esign_templates where id=$1`,
      [templateId, oldToken],
    );
    if (begin.status === "fulfilled") {
      expect(begin.value.rows[0].outcome).toBe("started");
      expect(reclaim.status).toBe("fulfilled");
      if (reclaim.status === "fulfilled") {
        expect(reclaim.value.rows[0].outcome).toBe("already_in_progress");
      }
      expect(state.rows[0]).toMatchObject({
        provider_create_state: "invoking",
        old_token_matches: true,
      });
    } else {
      expect(reclaim.status).toBe("fulfilled");
      if (reclaim.status === "fulfilled") {
        expect(reclaim.value.rows[0].outcome).toBe("claimed");
        expect(reclaim.value.rows[0].claim_token).not.toBe(oldToken);
        expect(state.rows[0].old_token_matches).toBe(false);
      }
      expect(state.rows[0].provider_create_state).toBe("claimed");
    }
  });

  it("serializes exact-expiry stale promotion against late completion", async () => {
    const source = await seedVerifiedSource();
    const templateId = await consume(source.id);
    const claim = await setup.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, templateId, source.id, ownerId],
    );
    const token = claim.rows[0].claim_token;
    await setup.query(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [orgId, templateId, source.id, token, ownerId],
    );
    await setup.query(
      `update public.esign_templates
       set provider_create_invocation_started_at=
         clock_timestamp()-interval '10 minutes'
       where id=$1`,
      [templateId],
    );
    const providerTemplateId = `stale-race-${crypto.randomUUID()}`;
    const [promote, complete] = await Promise.allSettled([
      first.query<{ outcome: string; provider_create_state: string }>(
        "select * from public.mark_stale_esign_template_provider_create_unknown($1,$2,$3,$4)",
        [orgId, templateId, source.id, ownerId],
      ),
      second.query<{ outcome: string; provider_template_id: string }>(
        "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
        [orgId, templateId, source.id, token, providerTemplateId, ownerId],
      ),
    ]);
    expect(promote.status).toBe("fulfilled");
    expect(complete.status).toBe("fulfilled");
    if (promote.status === "fulfilled") {
      expect(["recorded_unknown", "already_attached"]).toContain(
        promote.value.rows[0].outcome,
      );
    }
    if (complete.status === "fulfilled") {
      expect(complete.value.rows[0]).toMatchObject({
        outcome: "attached",
        provider_template_id: providerTemplateId,
      });
    }
    const final = await setup.query<{
      provider_create_state: string;
      provider_create_error_code: string | null;
      sign_template_id: string;
    }>(
      `select provider_create_state,provider_create_error_code,sign_template_id
       from public.esign_templates where id=$1`,
      [templateId],
    );
    expect(final.rows[0]).toEqual({
      provider_create_state: "attached",
      provider_create_error_code: null,
      sign_template_id: providerTemplateId,
    });
    await expect(
      setup.query(
        "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
        [orgId, templateId, source.id, token, providerTemplateId, ownerId],
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ outcome: "already_attached" })],
    });
    await expect(
      setup.query(
        "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
        [orgId, templateId, source.id, token, "stale-race-conflict", ownerId],
      ),
    ).rejects.toMatchObject({ message: expect.stringMatching(/conflicts/i) });
  });

  it("allows only one same-account cross-org attachment for a provider template ID", async () => {
    const firstSource = await seedVerifiedSource();
    const secondSource = await seedVerifiedSource(otherOrgId, otherOwnerId);
    const firstTemplate = await consume(firstSource.id);
    const secondTemplate = await consume(
      secondSource.id,
      otherOrgId,
      otherOwnerId,
    );
    const firstClaim = await setup.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, firstTemplate, firstSource.id, ownerId],
    );
    const secondClaim = await setup.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [otherOrgId, secondTemplate, secondSource.id, otherOwnerId],
    );
    await setup.query(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [orgId, firstTemplate, firstSource.id, firstClaim.rows[0].claim_token, ownerId],
    );
    await setup.query(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [
        otherOrgId,
        secondTemplate,
        secondSource.id,
        secondClaim.rows[0].claim_token,
        otherOwnerId,
      ],
    );
    const providerTemplateId = `race-shared-${crypto.randomUUID()}`;
    const attachments = await Promise.allSettled([
      first.query(
        "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
        [
          orgId,
          firstTemplate,
          firstSource.id,
          firstClaim.rows[0].claim_token,
          providerTemplateId,
          ownerId,
        ],
      ),
      second.query(
        "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
        [
          otherOrgId,
          secondTemplate,
          secondSource.id,
          secondClaim.rows[0].claim_token,
          providerTemplateId,
          otherOwnerId,
        ],
      ),
    ]);
    expect(attachments.map((result) => result.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    const attached = await setup.query<{ count: string }>(
      `select count(*) from public.esign_templates
       where provider_account_id='race-account' and sign_template_id=$1`,
      [providerTemplateId],
    );
    expect(attached.rows[0].count).toBe("1");
  });
});
