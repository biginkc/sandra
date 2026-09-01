import { readFileSync } from "node:fs";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { loadTestEnv } from "@tests/integration/env";

const baselineSql = readFileSync(
  "supabase/migrations/20260829194500_esign_foundation.sql",
  "utf8",
);
const forwardSql = readFileSync(
  "supabase/migrations/20260830080000_esign_template_upload_reservations.sql",
  "utf8",
);
const definitiveFailureSql = readFileSync(
  "supabase/migrations/20260901181004_record_definitive_esign_template_provider_create_failure.sql",
  "utf8",
);

let pg: Client;
let orgId = "";
let otherOrgId = "";
let creatorId = "";
let recoveryOwnerId = "";
let memberId = "";
let outsiderId = "";

function testDbUrl(): string {
  const env = loadTestEnv();
  const value = process.env.TEST_SUPABASE_DB_URL ?? env.TEST_SUPABASE_DB_URL;
  if (!value) throw new Error("Missing TEST_SUPABASE_DB_URL.");
  return value;
}

async function setRole(
  role: "anon" | "authenticated" | "service_role",
  userId = "",
): Promise<void> {
  await pg.query(`set local role ${role}`);
  await pg.query("select set_config('request.jwt.claim.role',$1,true)", [role]);
  await pg.query("select set_config('request.jwt.claim.sub',$1,true)", [userId]);
}

async function resetRole(): Promise<void> {
  await pg.query("reset role");
  await pg.query("select set_config('request.jwt.claim.role','',true)");
  await pg.query("select set_config('request.jwt.claim.sub','',true)");
}

async function expectDbError(
  operation: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await pg.query("savepoint expected_error");
  let caught: unknown;
  try {
    await operation();
  } catch (error) {
    caught = error;
  }
  await pg.query("rollback to savepoint expected_error");
  await pg.query("release savepoint expected_error");
  expect(caught).toMatchObject({ message: expect.stringMatching(pattern) });
}

async function seedIdentity(): Promise<void> {
  await resetRole();
  orgId = crypto.randomUUID();
  otherOrgId = crypto.randomUUID();
  creatorId = crypto.randomUUID();
  recoveryOwnerId = crypto.randomUUID();
  memberId = crypto.randomUUID();
  outsiderId = crypto.randomUUID();
  await pg.query("insert into auth.users(id) values ($1),($2),($3),($4)", [
    creatorId,
    recoveryOwnerId,
    memberId,
    outsiderId,
  ]);
  await pg.query(
    "insert into public.organizations(id,name) values ($1,'Forward A'),($2,'Forward B')",
    [orgId, otherOrgId],
  );
  await pg.query(
    `insert into public.memberships(user_id,org_id,role)
     values ($1,$4,'owner'),($2,$4,'owner'),($3,$4,'member'),($5,$6,'owner')`,
    [creatorId, recoveryOwnerId, memberId, orgId, outsiderId, otherOrgId],
  );
}

async function connectIntegration(
  targetOrgId: string,
  actorId: string,
  accountId: string,
): Promise<void> {
  await setRole("service_role");
  const callbackSecretHash = crypto.randomUUID().replaceAll("-", "").repeat(2);
  await pg.query(
    `select public.upsert_org_esign_integration(
       $1,'test-api-key-1234','1234','test-client',$2,$4,$3,
       'test-encryption-key'
     )`,
    [targetOrgId, accountId, actorId, callbackSecretHash],
  );
}

async function prepareAndVerify(input: {
  targetOrgId?: string;
  prepareActorId?: string;
  verifyActorId?: string;
} = {}): Promise<{ id: string; path: string }> {
  const targetOrgId = input.targetOrgId ?? orgId;
  const prepareActorId = input.prepareActorId ?? creatorId;
  const verifyActorId = input.verifyActorId ?? recoveryOwnerId;
  const id = crypto.randomUUID();
  const path = `${targetOrgId}/${id}.pdf`;
  await setRole("service_role");
  const prepared = await pg.query<{ outcome: string; storage_path: string }>(
    `select * from public.prepare_esign_template_source_upload(
       $1,$2,'agreement.pdf',1024,'application/pdf',repeat('b',64),$3
     )`,
    [targetOrgId, id, prepareActorId],
  );
  expect(prepared.rows[0]).toMatchObject({
    outcome: "prepared",
    storage_path: path,
  });
  await pg.query(
    `insert into storage.objects(bucket_id,name,metadata)
     values ('esign-staging',$1,jsonb_build_object(
       'mimetype','application/pdf','size',1024
     ))`,
    [path],
  );
  const verified = await pg.query<{ outcome: string }>(
    `select * from public.verify_esign_template_source_upload(
       $1,$2,$3,1024,'application/pdf',repeat('b',64),$4
     )`,
    [targetOrgId, id, path, verifyActorId],
  );
  expect(verified.rows[0].outcome).toBe("verified");
  return { id, path };
}

async function consumeDraft(
  sourceId: string,
  actorId = recoveryOwnerId,
  targetOrgId = orgId,
): Promise<{ outcome: string; template_id: string }> {
  const result = await pg.query<{ outcome: string; template_id: string }>(
    `select * from public.consume_esign_template_source_draft(
       $1,$2,'Purchase agreement','purchase_agreement','Seller',
       '[{"name":"Seller","order":0},{"name":"seller","order":1}]'::jsonb,
       $3
     )`,
    [targetOrgId, sourceId, actorId],
  );
  return result.rows[0];
}

async function finalizeOrdinaryTemplate(input: {
  targetOrgId?: string;
  actorId?: string;
  accountId?: string;
  providerTemplateId?: string;
  connect?: boolean;
} = {}): Promise<{ templateId: string; sourceId: string; sourcePath: string }> {
  const targetOrgId = input.targetOrgId ?? orgId;
  const actorId = input.actorId ?? creatorId;
  const accountId = input.accountId ?? "account-a";
  if (input.connect !== false) {
    await connectIntegration(targetOrgId, actorId, accountId);
  }
  const source = await prepareAndVerify({
    targetOrgId,
    prepareActorId: actorId,
    verifyActorId: actorId,
  });
  const draft = await consumeDraft(source.id, actorId, targetOrgId);
  const providerTemplateId =
    input.providerTemplateId ?? `provider-${draft.template_id}`;
  const claim = await pg.query<{ claim_token: string }>(
    "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
    [targetOrgId, draft.template_id, source.id, actorId],
  );
  await pg.query(
    "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
    [targetOrgId, draft.template_id, source.id, claim.rows[0].claim_token, actorId],
  );
  await pg.query(
    "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
    [
      targetOrgId,
      draft.template_id,
      source.id,
      claim.rows[0].claim_token,
      providerTemplateId,
      actorId,
    ],
  );
  await pg.query(
    `select public.finalize_esign_template(
       $1,$2,$3,'Seller',
       '[{"name":"Seller","order":0},{"name":"seller","order":1}]'::jsonb,
       array['seller_name','property_address','offer_price','closing_date','earnest_money'],
       $4
     )`,
    [targetOrgId, draft.template_id, providerTemplateId, actorId],
  );
  return {
    templateId: draft.template_id,
    sourceId: source.id,
    sourcePath: source.path,
  };
}

async function deleteStagingObject(path: string): Promise<void> {
  await resetRole();
  await pg.query("select set_config('storage.allow_delete_query','true',true)");
  try {
    await pg.query(
      "delete from storage.objects where bucket_id='esign-staging' and name=$1",
      [path],
    );
  } finally {
    await pg.query("select set_config('storage.allow_delete_query','false',true)");
  }
  await setRole("service_role");
}

async function recordAttachedSourceDeleted(input: {
  templateId: string;
  sourcePath: string;
  targetOrgId?: string;
  actorId?: string;
}): Promise<void> {
  const targetOrgId = input.targetOrgId ?? orgId;
  const actorId = input.actorId ?? creatorId;
  await deleteStagingObject(input.sourcePath);
  await pg.query(
    `select public.record_esign_template_source_cleanup(
       $1,$2,$3,'deleted',null,$4
     )`,
    [targetOrgId, input.templateId, input.sourcePath, actorId],
  );
}

beforeAll(async () => {
  pg = new Client({ connectionString: testDbUrl() });
  await pg.connect();
  await pg.query("begin");
  await pg.query(definitiveFailureSql);
});

beforeEach(async () => {
  await resetRole();
  await pg.query("savepoint forward_case");
  await seedIdentity();
});

afterEach(async () => {
  await resetRole();
  await pg.query("rollback to savepoint forward_case");
  await pg.query("release savepoint forward_case");
});

afterAll(async () => {
  if (pg) {
    await pg.query("rollback");
    await pg.end();
  }
});

describe("Migration 20260830080000 — durable template upload reservations", () => {
  it("keeps the ledgered foundation immutable and declares a forward-only chain", () => {
    expect(baselineSql).not.toContain("provider_account_id");
    expect(forwardSql).toContain("alter table public.org_esign_integrations");
    expect(forwardSql).toContain("claim_unattached_esign_template_source_cleanup");
    expect(forwardSql).toContain("claim_esign_template_provider_create");
    expect(forwardSql).toContain("mark_stale_esign_template_provider_create_unknown");
    expect(forwardSql).not.toContain("create table public.org_esign_integrations");
    expect(definitiveFailureSql).toContain(
      "record_definitive_esign_template_provider_create_failure",
    );
    expect(definitiveFailureSql).not.toContain(
      "mark_esign_template_provider_create_unknown(",
    );
  });

  it("keeps authenticated template options free of server-only recovery fields", async () => {
    await resetRole();
    const columns = await pg.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_schema='public' and table_name='available_esign_templates'
       order by ordinal_position`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).toEqual([
      "id",
      "org_id",
      "name",
      "document_type",
      "seller_role",
      "signer_roles",
      "merge_field_names",
      "sign_template_id",
      "staging_source_id",
      "source_filename",
      "source_size_bytes",
      "source_content_type",
      "source_sha256",
      "staging_path",
      "staging_deleted_at",
      "finalized_at",
      "lifecycle_state",
      "duplicate_of_template_id",
      "supersedes_template_id",
      "preparation_error_code",
      "abandoned_by",
      "abandoned_at",
      "created_by",
      "created_at",
      "updated_by",
      "updated_at",
      "deleted_by",
      "deleted_at",
    ]);
    expect(names).not.toEqual(
      expect.arrayContaining([
        "provider_account_id",
        "provider_create_claim_token_hash",
        "provider_create_last_released_token_hash",
        "provider_create_state",
        "provider_create_error_code",
        "provider_create_claimed_at",
        "provider_create_invocation_started_at",
      ]),
    );
    const widenedViews = await pg.query(
      `select distinct column_info.table_name,column_info.column_name
       from information_schema.columns column_info
       join information_schema.views view_info
         on view_info.table_schema=column_info.table_schema
        and view_info.table_name=column_info.table_name
       where column_info.table_schema='public'
         and column_info.column_name in (
           'provider_account_id','provider_create_claim_token_hash',
           'provider_create_last_released_token_hash','provider_create_state',
           'provider_create_error_code','provider_create_claimed_at',
           'provider_create_invocation_started_at','cleanup_token'
         )
         and has_table_privilege(
           'authenticated',
           format('%I.%I',column_info.table_schema,column_info.table_name),
           'select'
         )`,
    );
    expect(widenedViews.rows).toEqual([]);
  });

  it("returns finalized matching-account templates through the authenticated safe view", async () => {
    const { templateId } = await finalizeOrdinaryTemplate();
    const expectedKeys = [
      "abandoned_at",
      "abandoned_by",
      "created_at",
      "created_by",
      "deleted_at",
      "deleted_by",
      "document_type",
      "duplicate_of_template_id",
      "finalized_at",
      "id",
      "lifecycle_state",
      "merge_field_names",
      "name",
      "org_id",
      "preparation_error_code",
      "seller_role",
      "sign_template_id",
      "signer_roles",
      "source_content_type",
      "source_filename",
      "source_sha256",
      "source_size_bytes",
      "staging_deleted_at",
      "staging_path",
      "staging_source_id",
      "supersedes_template_id",
      "updated_at",
      "updated_by",
    ].sort();
    for (const userId of [creatorId, memberId]) {
      await resetRole();
      await setRole("authenticated", userId);
      const result = await pg.query(
        "select * from public.available_esign_templates where id=$1",
        [templateId],
      );
      expect(result.rows).toHaveLength(1);
      expect(Object.keys(result.rows[0]).sort()).toEqual(expectedKeys);
      expect(result.rows[0]).toMatchObject({
        id: templateId,
        org_id: orgId,
        name: "Purchase agreement",
      });
    }
    await resetRole();
    await setRole("authenticated", outsiderId);
    await expect(
      pg.query("select * from public.available_esign_templates where id=$1", [templateId]),
    ).resolves.toMatchObject({ rows: [] });
  });

  it("scopes provider template IDs by the immutable provider account", async () => {
    const providerTemplateId = `shared-provider-${crypto.randomUUID()}`;
    await finalizeOrdinaryTemplate({ providerTemplateId });
    await connectIntegration(otherOrgId, outsiderId, "account-a");
    const conflictingSource = await prepareAndVerify({
      targetOrgId: otherOrgId,
      prepareActorId: outsiderId,
      verifyActorId: outsiderId,
    });
    const conflictingDraft = await consumeDraft(
      conflictingSource.id,
      outsiderId,
      otherOrgId,
    );
    const conflictingClaim = await pg.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [otherOrgId, conflictingDraft.template_id, conflictingSource.id, outsiderId],
    );
    await pg.query(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [
        otherOrgId,
        conflictingDraft.template_id,
        conflictingSource.id,
        conflictingClaim.rows[0].claim_token,
        outsiderId,
      ],
    );
    await expectDbError(
      () =>
        pg.query(
          "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
          [
            otherOrgId,
            conflictingDraft.template_id,
            conflictingSource.id,
            conflictingClaim.rows[0].claim_token,
            providerTemplateId,
            outsiderId,
          ],
        ),
      /idx_esign_templates_provider_id|duplicate key/i,
    );
  });

  it("allows the same provider template ID under distinct provider accounts", async () => {
    const providerTemplateId = `account-scoped-${crypto.randomUUID()}`;
    const first = await finalizeOrdinaryTemplate({ providerTemplateId });
    const second = await finalizeOrdinaryTemplate({
      targetOrgId: otherOrgId,
      actorId: outsiderId,
      accountId: "account-b",
      providerTemplateId,
    });
    const rows = await pg.query<{
      id: string;
      provider_account_id: string;
      sign_template_id: string;
    }>(
      `select id,provider_account_id,sign_template_id
       from public.esign_templates where id=any($1::uuid[]) order by id`,
      [[first.templateId, second.templateId]],
    );
    expect(rows.rows.map((row) => row.provider_account_id).sort()).toEqual([
      "account-a",
      "account-b",
    ]);
    expect(rows.rows.every((row) => row.sign_template_id === providerTemplateId)).toBe(
      true,
    );
  });

  it("hides old-account templates until the same account reconnects", async () => {
    const finalized = await finalizeOrdinaryTemplate();
    await recordAttachedSourceDeleted(finalized);
    await pg.query("select public.delete_org_esign_integration($1,$2)", [
      orgId,
      creatorId,
    ]);
    await connectIntegration(orgId, creatorId, "account-b");
    await pg.query(
      `update public.org_esign_integrations
       set callback_verified_at=now(),sending_enabled=true where org_id=$1`,
      [orgId],
    );
    await resetRole();
    await setRole("authenticated", creatorId);
    await expect(
      pg.query("select id from public.available_esign_templates where id=$1", [
        finalized.templateId,
      ]),
    ).resolves.toMatchObject({ rows: [] });
    await resetRole();
    await setRole("service_role");
    await expectDbError(
      () =>
        pg.query(
          "select public.create_esign_template_duplicate_draft($1,$2,'Copy',$3)",
          [orgId, finalized.templateId, recoveryOwnerId],
        ),
      /provider account does not match/i,
    );
    const editSource = await prepareAndVerify({
      prepareActorId: recoveryOwnerId,
      verifyActorId: recoveryOwnerId,
    });
    await expectDbError(
      () =>
        pg.query(
          "select public.create_esign_template_edit_revision($1,$2,$3,$4)",
          [orgId, finalized.templateId, editSource.id, recoveryOwnerId],
        ),
      /provider account does not match/i,
    );
    const send = await pg.query<{ outcome: string; blocker_code: string }>(
      `select outcome,blocker_code from public.create_esign_request(
         $1,$2,$3,'[]'::jsonb,'{}'::jsonb,$4,repeat('a',64),null,$5
       )`,
      [
        orgId,
        crypto.randomUUID(),
        finalized.templateId,
        crypto.randomUUID(),
        memberId,
      ],
    );
    expect(send.rows[0]).toEqual({
      outcome: "blocked",
      blocker_code: "FINALIZED_TEMPLATE_NOT_FOUND",
    });
    await pg.query("select public.delete_org_esign_integration($1,$2)", [
      orgId,
      creatorId,
    ]);
    await connectIntegration(orgId, creatorId, "account-a");
    await resetRole();
    await setRole("authenticated", memberId);
    await expect(
      pg.query("select id from public.available_esign_templates where id=$1", [
        finalized.templateId,
      ]),
    ).resolves.toMatchObject({ rows: [{ id: finalized.templateId }] });
  });

  it("refuses disconnect for every unfinished template operation", async () => {
    for (const state of ["unstarted", "claimed", "invoking", "unknown"] as const) {
      await pg.query(`savepoint disconnect_${state}`);
      await connectIntegration(orgId, creatorId, "account-a");
      const source = await prepareAndVerify();
      const draft = await consumeDraft(source.id);
      const claim =
        state === "unstarted"
          ? null
          : await pg.query<{ claim_token: string }>(
              "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
              [orgId, draft.template_id, source.id, recoveryOwnerId],
            );
      if (state === "invoking" || state === "unknown") {
        await pg.query(
          "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
          [
            orgId,
            draft.template_id,
            source.id,
            claim!.rows[0].claim_token,
            recoveryOwnerId,
          ],
        );
      }
      if (state === "unknown") {
        await pg.query(
          "select * from public.mark_esign_template_provider_create_unknown($1,$2,$3,$4,'PROVIDER_RESPONSE_UNKNOWN',$5)",
          [
            orgId,
            draft.template_id,
            source.id,
            claim!.rows[0].claim_token,
            recoveryOwnerId,
          ],
        );
      }
      if (state !== "unstarted") {
        await expectDbError(
          () =>
            pg.query("select public.abandon_esign_template_draft($1,$2,$3)", [
              orgId,
              draft.template_id,
              recoveryOwnerId,
            ]),
          /resolve the provider create/i,
        );
      }
      await expectDbError(
        () => pg.query("select public.delete_org_esign_integration($1,$2)", [orgId, creatorId]),
        /provider template operation|finish or abandon template setup/i,
      );
      await pg.query(`rollback to savepoint disconnect_${state}`);
      await pg.query(`release savepoint disconnect_${state}`);
    }

    await pg.query("savepoint disconnect_duplicate");
    const finalizedDuplicate = await finalizeOrdinaryTemplate();
    await recordAttachedSourceDeleted(finalizedDuplicate);
    const duplicate = await pg.query<{ id: string }>(
      "select public.create_esign_template_duplicate_draft($1,$2,'Duplicate',$3) id",
      [orgId, finalizedDuplicate.templateId, recoveryOwnerId],
    );
    await expectDbError(
      () => pg.query("select public.delete_org_esign_integration($1,$2)", [orgId, creatorId]),
      /finish or abandon template setup/i,
    );
    await pg.query("select public.abandon_esign_template_draft($1,$2,$3)", [
      orgId,
      duplicate.rows[0].id,
      recoveryOwnerId,
    ]);
    await expect(
      pg.query("select public.delete_org_esign_integration($1,$2)", [orgId, creatorId]),
    ).resolves.toBeDefined();
    await pg.query("rollback to savepoint disconnect_duplicate");
    await pg.query("release savepoint disconnect_duplicate");

    await pg.query("savepoint disconnect_edit");
    const finalizedEdit = await finalizeOrdinaryTemplate();
    await recordAttachedSourceDeleted(finalizedEdit);
    const editSource = await prepareAndVerify();
    const edit = await pg.query<{ id: string }>(
      "select public.create_esign_template_edit_revision($1,$2,$3,$4) id",
      [orgId, finalizedEdit.templateId, editSource.id, recoveryOwnerId],
    );
    await expectDbError(
      () => pg.query("select public.delete_org_esign_integration($1,$2)", [orgId, creatorId]),
      /finish or abandon template setup/i,
    );
    await pg.query("select public.abandon_esign_template_draft($1,$2,$3)", [
      orgId,
      edit.rows[0].id,
      recoveryOwnerId,
    ]);
    await recordAttachedSourceDeleted({
      templateId: edit.rows[0].id,
      sourcePath: editSource.path,
      actorId: recoveryOwnerId,
    });
    await expect(
      pg.query("select public.delete_org_esign_integration($1,$2)", [orgId, creatorId]),
    ).resolves.toBeDefined();
    await pg.query("rollback to savepoint disconnect_edit");
    await pg.query("release savepoint disconnect_edit");

    await pg.query("savepoint disconnect_cleanup");
    const finalizedCleanup = await finalizeOrdinaryTemplate();
    await pg.query(
      `select public.record_esign_template_source_cleanup(
         $1,$2,$3,'failed','DELETE_FAILED',$4
       )`,
      [orgId, finalizedCleanup.templateId, finalizedCleanup.sourcePath, creatorId],
    );
    await expectDbError(
      () => pg.query("select public.delete_org_esign_integration($1,$2)", [orgId, creatorId]),
      /attached template source cleanup/i,
    );
    await recordAttachedSourceDeleted(finalizedCleanup);
    await expect(
      pg.query("select public.delete_org_esign_integration($1,$2)", [orgId, creatorId]),
    ).resolves.toBeDefined();
    await pg.query("rollback to savepoint disconnect_cleanup");
    await pg.query("release savepoint disconnect_cleanup");
  });

  it("allows safe template columns but denies internal recovery columns to owners and members", async () => {
    for (const userId of [creatorId, memberId]) {
      await resetRole();
      await setRole("authenticated", userId);
      await expect(
        pg.query("select id,name,sign_template_id from public.esign_templates"),
      ).resolves.toMatchObject({ rows: [] });
      await expectDbError(
        () =>
          pg.query(
            `select provider_account_id,provider_create_claim_token_hash,
                    provider_create_last_released_token_hash,
                    provider_create_state,provider_create_error_code,
                    provider_create_claimed_at,
                    provider_create_invocation_started_at
             from public.esign_templates`,
          ),
        /permission denied/i,
      );
    }
  });

  it("allows browser upload only for an exact durable reservation", async () => {
    await setRole("service_role");
    const sourceId = crypto.randomUUID();
    const path = `${orgId}/${sourceId}.pdf`;
    await pg.query(
      `select * from public.prepare_esign_template_source_upload(
         $1,$2,'browser.pdf',1024,'application/pdf',repeat('9',64),$3
       )`,
      [orgId, sourceId, creatorId],
    );
    await resetRole();
    await setRole("authenticated", creatorId);
    await expect(
      pg.query("select public.esign_staging_upload_is_reserved($1) reserved", [path]),
    ).resolves.toMatchObject({ rows: [{ reserved: true }] });
    await expect(
      pg.query(
        `insert into storage.objects(bucket_id,name,metadata)
         values ('esign-staging',$1,jsonb_build_object(
           'mimetype','application/pdf','size',1024
         ))`,
        [path],
      ),
    ).resolves.toBeDefined();
    const unreserved = `${orgId}/${crypto.randomUUID()}.pdf`;
    await expectDbError(
      () =>
        pg.query(
          `insert into storage.objects(bucket_id,name,metadata)
           values ('esign-staging',$1,jsonb_build_object(
             'mimetype','application/pdf','size',1024
           ))`,
          [unreserved],
        ),
      /row-level security|policy/i,
    );
    for (const userId of [memberId, outsiderId]) {
      await resetRole();
      await setRole("authenticated", userId);
      await expect(
        pg.query("select public.esign_staging_upload_is_reserved($1) reserved", [path]),
      ).resolves.toMatchObject({ rows: [{ reserved: false }] });
    }
    await resetRole();
    await setRole("service_role");
    await expect(
      pg.query("select public.esign_staging_upload_is_reserved($1) reserved", [path]),
    ).resolves.toMatchObject({ rows: [{ reserved: true }] });
  });

  it("grants every new security-definer seam only to service_role", async () => {
    await resetRole();
    const signatures = [
      "prepare_esign_template_source_upload(uuid,uuid,text,bigint,text,text,uuid)",
      "verify_esign_template_source_upload(uuid,uuid,text,bigint,text,text,uuid)",
      "record_verified_esign_template_source(uuid,uuid,text,text,bigint,text,text,uuid)",
      "consume_esign_template_source_draft(uuid,uuid,text,text,text,jsonb,uuid)",
      "create_esign_template_draft(uuid,uuid,text,text,text,jsonb,uuid)",
      "claim_unattached_esign_template_source_cleanup(uuid,uuid,text,uuid)",
      "complete_unattached_esign_template_source_cleanup(uuid,uuid,text,uuid,text,text,uuid)",
      "list_pending_esign_template_source_uploads(uuid,uuid)",
      "abandon_esign_template_draft(uuid,uuid,uuid)",
      "claim_esign_template_provider_create(uuid,uuid,uuid,uuid)",
      "begin_esign_template_provider_create(uuid,uuid,uuid,uuid,uuid)",
      "release_esign_template_provider_create_claim(uuid,uuid,uuid,uuid,uuid)",
      "record_definitive_esign_template_provider_create_failure(uuid,uuid,uuid,uuid,text,uuid)",
      "mark_esign_template_provider_create_unknown(uuid,uuid,uuid,uuid,text,uuid)",
      "mark_stale_esign_template_provider_create_unknown(uuid,uuid,uuid,uuid)",
      "complete_esign_template_provider_create(uuid,uuid,uuid,uuid,text,uuid)",
      "reconcile_unknown_esign_template_provider_create(uuid,uuid,uuid,text,uuid)",
      "list_pending_esign_template_provider_creates(uuid,uuid)",
      "create_esign_template_duplicate_draft(uuid,uuid,text,uuid)",
      "create_esign_template_edit_revision(uuid,uuid,uuid,uuid)",
      "attach_esign_template_provider_id(uuid,uuid,text,uuid)",
      "finalize_esign_template(uuid,uuid,text,text,jsonb,text[],uuid)",
      "publish_esign_template_edit_revision(uuid,uuid,uuid,text,text,text,jsonb,text[],uuid)",
      "soft_delete_esign_template(uuid,uuid,boolean,uuid)",
      "create_esign_request(uuid,uuid,uuid,jsonb,jsonb,uuid,text,uuid,uuid)",
      "upsert_org_esign_integration(uuid,text,text,text,text,text,uuid,text)",
      "get_org_esign_credentials(uuid,text)",
      "delete_org_esign_integration(uuid,uuid)",
    ];
    for (const signature of signatures) {
      const privilege = await pg.query<{
        public_exec: boolean;
        anon_exec: boolean;
        authenticated_exec: boolean;
        service_exec: boolean;
      }>(
        `select
           has_function_privilege('public',$1,'execute') public_exec,
           has_function_privilege('anon',$1,'execute') anon_exec,
           has_function_privilege('authenticated',$1,'execute') authenticated_exec,
           has_function_privilege('service_role',$1,'execute') service_exec`,
        [`public.${signature}`],
      );
      expect(privilege.rows[0]).toEqual({
        public_exec: false,
        anon_exec: false,
        authenticated_exec: false,
        service_exec: true,
      });
    }
    for (const identity of [
      { role: "anon" as const, userId: "" },
      { role: "authenticated" as const, userId: outsiderId },
      { role: "authenticated" as const, userId: memberId },
      { role: "authenticated" as const, userId: creatorId },
    ]) {
      await resetRole();
      await setRole(identity.role, identity.userId);
      await expectDbError(
        () =>
          pg.query(
            `select public.prepare_esign_template_source_upload(
               $1,$2,'forbidden.pdf',1,'application/pdf',repeat('c',64),$3
             )`,
            [orgId, crypto.randomUUID(), creatorId],
          ),
        /permission denied/i,
      );
      await expectDbError(
        () =>
          pg.query(
            "select * from public.mark_stale_esign_template_provider_create_unknown($1,$2,$3,$4)",
            [orgId, crypto.randomUUID(), crypto.randomUUID(), creatorId],
          ),
        /permission denied/i,
      );
      await expectDbError(
        () =>
          pg.query(
            "select * from public.list_pending_esign_template_provider_creates($1,$2)",
            [orgId, creatorId],
          ),
        /permission denied/i,
      );
    }
    await resetRole();
    await setRole("service_role");
    await expectDbError(
      () =>
        pg.query(
          `select public.prepare_esign_template_source_upload(
             $1,$2,'forbidden.pdf',1,'application/pdf',repeat('c',64),$3
           )`,
          [otherOrgId, crypto.randomUUID(), creatorId],
        ),
      /active organization owner required/i,
    );
  });

  it("supports prepare, owner-rotation verification, exact-once consume, and provider claim recovery", async () => {
    await connectIntegration(orgId, creatorId, "account-a");
    const source = await prepareAndVerify();
    const first = await consumeDraft(source.id);
    const replay = await consumeDraft(source.id, creatorId);
    expect(first.outcome).toBe("created");
    expect(replay).toEqual({
      outcome: "existing_same_contract",
      template_id: first.template_id,
    });
    await expectDbError(
      () =>
        pg.query(
          "select * from public.claim_unattached_esign_template_source_cleanup($1,$2,$3,$4)",
          [orgId, source.id, source.path, recoveryOwnerId],
        ),
      /attached template source/i,
    );
    const claim = await pg.query<{
      outcome: string;
      claim_token: string;
      provider_account_id: string;
    }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, first.template_id, source.id, recoveryOwnerId],
    );
    expect(claim.rows[0]).toMatchObject({
      outcome: "claimed",
      provider_account_id: "account-a",
    });
    const blocked = await pg.query<{ outcome: string; claim_token: string | null }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, first.template_id, source.id, creatorId],
    );
    expect(blocked.rows[0]).toMatchObject({
      outcome: "already_in_progress",
      claim_token: null,
    });
    await pg.query(
      `update public.esign_templates
       set provider_create_claimed_at=clock_timestamp()-interval '10 minutes'
       where id=$1`,
      [first.template_id],
    );
    const reclaimed = await pg.query<{ outcome: string; claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, first.template_id, source.id, creatorId],
    );
    expect(reclaimed.rows[0].outcome).toBe("claimed");
    expect(reclaimed.rows[0].claim_token).not.toBe(claim.rows[0].claim_token);
    await expectDbError(
      () =>
        pg.query(
          "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
          [orgId, first.template_id, source.id, claim.rows[0].claim_token, creatorId],
        ),
      /token does not match/i,
    );
    const started = await pg.query<{ outcome: string }>(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [
        orgId,
        first.template_id,
        source.id,
        reclaimed.rows[0].claim_token,
        recoveryOwnerId,
      ],
    );
    expect(started.rows[0].outcome).toBe("started");
    await pg.query(
      "select * from public.mark_esign_template_provider_create_unknown($1,$2,$3,$4,'PROVIDER_RESPONSE_UNKNOWN',$5)",
      [
        orgId,
        first.template_id,
        source.id,
        reclaimed.rows[0].claim_token,
        recoveryOwnerId,
      ],
    );
    const neverReclaimed = await pg.query<{ outcome: string; provider_create_state: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, first.template_id, source.id, creatorId],
    );
    expect(neverReclaimed.rows[0]).toMatchObject({
      outcome: "already_in_progress",
      provider_create_state: "unknown",
    });
  });

  it("promotes only stale invoking provider creates and preserves late completion and manual reconciliation", async () => {
    await connectIntegration(orgId, creatorId, "account-a");
    const source = await prepareAndVerify();
    const draft = await consumeDraft(source.id, creatorId);
    const claim = await pg.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, draft.template_id, source.id, creatorId],
    );
    const token = claim.rows[0].claim_token;
    await pg.query(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [orgId, draft.template_id, source.id, token, creatorId],
    );

    await expectDbError(
      () =>
        pg.query(
          "select * from public.mark_stale_esign_template_provider_create_unknown($1,$2,$3,$4)",
          [orgId, draft.template_id, crypto.randomUUID(), recoveryOwnerId],
        ),
      /not found/i,
    );
    await expectDbError(
      () =>
        pg.query(
          "select * from public.mark_stale_esign_template_provider_create_unknown($1,$2,$3,$4)",
          [orgId, draft.template_id, source.id, recoveryOwnerId],
        ),
      /not stale/i,
    );
    await pg.query(
      `update public.esign_templates
       set provider_create_invocation_started_at=
         clock_timestamp()-interval '9 minutes 59 seconds'
       where id=$1`,
      [draft.template_id],
    );
    await expectDbError(
      () =>
        pg.query(
          "select * from public.mark_stale_esign_template_provider_create_unknown($1,$2,$3,$4)",
          [orgId, draft.template_id, source.id, recoveryOwnerId],
        ),
      /not stale/i,
    );
    await pg.query(
      `update public.esign_templates
       set provider_create_invocation_started_at=
         clock_timestamp()-interval '10 minutes'
       where id=$1`,
      [draft.template_id],
    );
    const promoted = await pg.query<{
      outcome: string;
      template_id: string;
      provider_create_state: string;
      created_by: string;
    }>(
      "select * from public.mark_stale_esign_template_provider_create_unknown($1,$2,$3,$4)",
      [orgId, draft.template_id, source.id, recoveryOwnerId],
    );
    expect(promoted.rows[0]).toEqual({
      outcome: "recorded_unknown",
      template_id: draft.template_id,
      provider_create_state: "unknown",
      created_by: creatorId,
    });
    const unknownState = await pg.query<{
      provider_create_state: string;
      provider_create_error_code: string | null;
    }>(
      `select provider_create_state,provider_create_error_code
       from public.esign_templates where id=$1`,
      [draft.template_id],
    );
    expect(unknownState.rows[0]).toEqual({
      provider_create_state: "unknown",
      provider_create_error_code: "PROVIDER_CREATE_INVOCATION_STALE",
    });
    const replay = await pg.query<{
      outcome: string;
      provider_create_state: string;
    }>(
      "select * from public.mark_stale_esign_template_provider_create_unknown($1,$2,$3,$4)",
      [orgId, draft.template_id, source.id, creatorId],
    );
    expect(replay.rows[0]).toMatchObject({
      outcome: "already_unknown",
      provider_create_state: "unknown",
    });
    const noReinvoke = await pg.query<{
      outcome: string;
      provider_create_state: string;
      claim_token: string | null;
    }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, draft.template_id, source.id, creatorId],
    );
    expect(noReinvoke.rows[0]).toMatchObject({
      outcome: "already_in_progress",
      provider_create_state: "unknown",
      claim_token: null,
    });

    const providerTemplateId = `provider-stale-${crypto.randomUUID()}`;
    const lateCompletion = await pg.query<{ outcome: string }>(
      "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
      [orgId, draft.template_id, source.id, token, providerTemplateId, creatorId],
    );
    expect(lateCompletion.rows[0].outcome).toBe("attached");
    const attachedReplay = await pg.query<{
      outcome: string;
      provider_create_state: string;
    }>(
      "select * from public.mark_stale_esign_template_provider_create_unknown($1,$2,$3,$4)",
      [orgId, draft.template_id, source.id, recoveryOwnerId],
    );
    expect(attachedReplay.rows[0]).toMatchObject({
      outcome: "already_attached",
      provider_create_state: "attached",
    });
    await expect(
      pg.query(
        "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
        [orgId, draft.template_id, source.id, token, providerTemplateId, recoveryOwnerId],
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ outcome: "already_attached" })],
    });
    await expectDbError(
      () =>
        pg.query(
          "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
          [orgId, draft.template_id, source.id, token, "provider-conflict", recoveryOwnerId],
        ),
      /conflicts/i,
    );

    const reconcileSource = await prepareAndVerify();
    const reconcileDraft = await consumeDraft(reconcileSource.id);
    const reconcileClaim = await pg.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, reconcileDraft.template_id, reconcileSource.id, creatorId],
    );
    await pg.query(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [
        orgId,
        reconcileDraft.template_id,
        reconcileSource.id,
        reconcileClaim.rows[0].claim_token,
        creatorId,
      ],
    );
    await pg.query(
      `update public.esign_templates
       set provider_create_invocation_started_at=
         clock_timestamp()-interval '10 minutes'
       where id=$1`,
      [reconcileDraft.template_id],
    );
    await pg.query(
      "select * from public.mark_stale_esign_template_provider_create_unknown($1,$2,$3,$4)",
      [orgId, reconcileDraft.template_id, reconcileSource.id, recoveryOwnerId],
    );
    const reconciled = await pg.query<{ outcome: string }>(
      "select * from public.reconcile_unknown_esign_template_provider_create($1,$2,$3,$4,$5)",
      [
        orgId,
        reconcileDraft.template_id,
        reconcileSource.id,
        "provider-manually-reconciled",
        recoveryOwnerId,
      ],
    );
    expect(reconciled.rows[0].outcome).toBe("attached");
    await expect(
      pg.query(
        "select * from public.reconcile_unknown_esign_template_provider_create($1,$2,$3,$4,$5)",
        [
          orgId,
          reconcileDraft.template_id,
          reconcileSource.id,
          "provider-manually-reconciled",
          creatorId,
        ],
      ),
    ).resolves.toMatchObject({
      rows: [expect.objectContaining({ outcome: "already_attached" })],
    });
    await expectDbError(
      () =>
        pg.query(
          "select * from public.reconcile_unknown_esign_template_provider_create($1,$2,$3,$4,$5)",
          [
            orgId,
            reconcileDraft.template_id,
            reconcileSource.id,
            "provider-manual-conflict",
            creatorId,
          ],
        ),
      /conflicts/i,
    );
  });

  it("returns a definitive provider rejection to a token-fenced retryable state", async () => {
    await connectIntegration(orgId, creatorId, "account-a");
    const source = await prepareAndVerify();
    const draft = await consumeDraft(source.id, creatorId);
    const claim = await pg.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, draft.template_id, source.id, creatorId],
    );
    const token = claim.rows[0].claim_token;
    await pg.query(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [orgId, draft.template_id, source.id, token, creatorId],
    );

    await expectDbError(
      () =>
        pg.query(
          "select * from public.record_definitive_esign_template_provider_create_failure($1,$2,$3,$4,'PROVIDER_REQUEST_REJECTED',$5)",
          [orgId, draft.template_id, source.id, crypto.randomUUID(), creatorId],
        ),
      /cannot record a definitive failure/i,
    );
    const recorded = await pg.query<{ outcome: string }>(
      "select * from public.record_definitive_esign_template_provider_create_failure($1,$2,$3,$4,'PROVIDER_REQUEST_REJECTED',$5)",
      [orgId, draft.template_id, source.id, token, creatorId],
    );
    expect(recorded.rows[0].outcome).toBe("recorded_failure");
    const replay = await pg.query<{ outcome: string }>(
      "select * from public.record_definitive_esign_template_provider_create_failure($1,$2,$3,$4,'PROVIDER_REQUEST_REJECTED',$5)",
      [orgId, draft.template_id, source.id, token, recoveryOwnerId],
    );
    expect(replay.rows[0].outcome).toBe("already_recorded");

    const state = await pg.query<{
      provider_create_state: string;
      provider_account_id: string | null;
      provider_create_error_code: string;
    }>(
      `select provider_create_state, provider_account_id,
         provider_create_error_code
       from public.esign_templates where id=$1`,
      [draft.template_id],
    );
    expect(state.rows[0]).toEqual({
      provider_create_state: "unstarted",
      provider_account_id: null,
      provider_create_error_code: null,
    });

    const retried = await pg.query<{
      outcome: string;
      claim_token: string;
    }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, draft.template_id, source.id, recoveryOwnerId],
    );
    expect(retried.rows[0].outcome).toBe("claimed");
    expect(retried.rows[0].claim_token).not.toBe(token);
  });

  it("lists attached unfinished initial drafts without leaking finalized, duplicate, or edit rows", async () => {
    await connectIntegration(orgId, creatorId, "account-a");
    const source = await prepareAndVerify();
    const draft = await consumeDraft(source.id, creatorId);
    const claim = await pg.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, draft.template_id, source.id, creatorId],
    );
    await pg.query(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [orgId, draft.template_id, source.id, claim.rows[0].claim_token, creatorId],
    );
    await pg.query(
      "select * from public.complete_esign_template_provider_create($1,$2,$3,$4,$5,$6)",
      [
        orgId,
        draft.template_id,
        source.id,
        claim.rows[0].claim_token,
        "provider-response-lost",
        creatorId,
      ],
    );

    const pending = await pg.query<Record<string, unknown>>(
      "select * from public.list_pending_esign_template_provider_creates($1,$2)",
      [orgId, recoveryOwnerId],
    );
    expect(pending.rows).toHaveLength(1);
    expect(Object.keys(pending.rows[0]).sort()).toEqual([
      "created_at",
      "created_by",
      "name",
      "provider_create_claimed_at",
      "provider_create_error_code",
      "provider_create_invocation_started_at",
      "provider_create_state",
      "source_id",
      "template_id",
    ]);
    expect(pending.rows[0]).toMatchObject({
      template_id: draft.template_id,
      source_id: source.id,
      name: "Purchase agreement",
      provider_create_state: "attached",
      provider_create_claimed_at: expect.any(Date),
      provider_create_invocation_started_at: expect.any(Date),
      provider_create_error_code: null,
      created_by: creatorId,
      created_at: expect.any(Date),
    });
    expect(pending.rows[0]).not.toHaveProperty("provider_account_id");
    expect(pending.rows[0]).not.toHaveProperty("claim_token");

    await expectDbError(
      () =>
        pg.query(
          "select * from public.list_pending_esign_template_provider_creates($1,$2)",
          [orgId, outsiderId],
        ),
      /active organization owner required/i,
    );
    await expect(
      pg.query(
        "select * from public.list_pending_esign_template_provider_creates($1,$2)",
        [otherOrgId, outsiderId],
      ),
    ).resolves.toMatchObject({ rows: [] });

    await pg.query(
      `select public.finalize_esign_template(
         $1,$2,'provider-response-lost','Seller',
         '[{"name":"Seller","order":0},{"name":"seller","order":1}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         $3
       )`,
      [orgId, draft.template_id, recoveryOwnerId],
    );
    const duplicate = await pg.query<{ id: string }>(
      "select public.create_esign_template_duplicate_draft($1,$2,'Hidden duplicate',$3) id",
      [orgId, draft.template_id, creatorId],
    );
    const editSource = await prepareAndVerify();
    const edit = await pg.query<{ id: string }>(
      "select public.create_esign_template_edit_revision($1,$2,$3,$4) id",
      [orgId, draft.template_id, editSource.id, creatorId],
    );
    const afterFinalize = await pg.query<{ template_id: string }>(
      "select * from public.list_pending_esign_template_provider_creates($1,$2)",
      [orgId, recoveryOwnerId],
    );
    expect(afterFinalize.rows).toEqual([]);
    const listedIds = afterFinalize.rows.map((row) => row.template_id);
    expect(listedIds).not.toContain(draft.template_id);
    expect(listedIds).not.toContain(duplicate.rows[0].id);
    expect(listedIds).not.toContain(edit.rows[0].id);
  });

  it("lets current owners recover each reservation and provider-create stage after creator departure", async () => {
    await connectIntegration(orgId, creatorId, "account-a");
    const sourceId = crypto.randomUUID();
    const path = `${orgId}/${sourceId}.pdf`;
    await pg.query(
      `select * from public.prepare_esign_template_source_upload(
         $1,$2,'rotation.pdf',1024,'application/pdf',repeat('7',64),$3
       )`,
      [orgId, sourceId, creatorId],
    );
    await resetRole();
    await pg.query(
      "update public.memberships set access_status='suspended' where org_id=$1 and user_id=$2",
      [orgId, creatorId],
    );
    await pg.query(
      `insert into storage.objects(bucket_id,name,metadata)
       values ('esign-staging',$1,jsonb_build_object(
         'mimetype','application/pdf','size',1024
       ))`,
      [path],
    );
    await setRole("service_role");
    await pg.query(
      `select * from public.verify_esign_template_source_upload(
         $1,$2,$3,1024,'application/pdf',repeat('7',64),$4
       )`,
      [orgId, sourceId, path, recoveryOwnerId],
    );
    const draft = await consumeDraft(sourceId, recoveryOwnerId);
    const claim = await pg.query<{ claim_token: string }>(
      "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
      [orgId, draft.template_id, sourceId, recoveryOwnerId],
    );
    await pg.query(
      "select * from public.begin_esign_template_provider_create($1,$2,$3,$4,$5)",
      [
        orgId,
        draft.template_id,
        sourceId,
        claim.rows[0].claim_token,
        recoveryOwnerId,
      ],
    );
    await pg.query(
      "select * from public.mark_esign_template_provider_create_unknown($1,$2,$3,$4,'PROVIDER_RESPONSE_UNKNOWN',$5)",
      [
        orgId,
        draft.template_id,
        sourceId,
        claim.rows[0].claim_token,
        recoveryOwnerId,
      ],
    );
    await resetRole();
    await pg.query(
      `update public.memberships set access_status='active' where org_id=$1 and user_id=$2`,
      [orgId, creatorId],
    );
    await pg.query(
      `update public.memberships set access_status='suspended' where org_id=$1 and user_id=$2`,
      [orgId, recoveryOwnerId],
    );
    await setRole("service_role");
    const reconciled = await pg.query<{ outcome: string; created_by: string }>(
      "select * from public.reconcile_unknown_esign_template_provider_create($1,$2,$3,$4,$5)",
      [orgId, draft.template_id, sourceId, "provider-rotation", creatorId],
    );
    expect(reconciled.rows[0]).toEqual({
      outcome: "attached",
      template_id: draft.template_id,
      provider_template_id: "provider-rotation",
      created_by: recoveryOwnerId,
    });
  });

  it("leases unattached cleanup, rejects old tokens, and converges after response loss", async () => {
    const sourceId = crypto.randomUUID();
    const path = `${orgId}/${sourceId}.pdf`;
    await setRole("service_role");
    await pg.query(
      `select * from public.prepare_esign_template_source_upload(
         $1,$2,'orphan.pdf',1024,'application/pdf',repeat('d',64),$3
       )`,
      [orgId, sourceId, creatorId],
    );
    const first = await pg.query<{ outcome: string; cleanup_token: string }>(
      "select * from public.claim_unattached_esign_template_source_cleanup($1,$2,$3,$4)",
      [orgId, sourceId, path, recoveryOwnerId],
    );
    const inProgress = await pg.query<{ outcome: string; cleanup_token: string | null }>(
      "select * from public.claim_unattached_esign_template_source_cleanup($1,$2,$3,$4)",
      [orgId, sourceId, path, creatorId],
    );
    expect(inProgress.rows[0]).toMatchObject({
      outcome: "already_in_progress",
      cleanup_token: null,
    });
    await pg.query(
      `update public.esign_template_staging_sources
       set cleanup_claimed_at=clock_timestamp()-interval '10 minutes'
       where id=$1`,
      [sourceId],
    );
    const reclaimed = await pg.query<{ cleanup_token: string }>(
      "select * from public.claim_unattached_esign_template_source_cleanup($1,$2,$3,$4)",
      [orgId, sourceId, path, recoveryOwnerId],
    );
    expect(reclaimed.rows[0].cleanup_token).not.toBe(first.rows[0].cleanup_token);
    await expectDbError(
      () =>
        pg.query(
          "select * from public.complete_unattached_esign_template_source_cleanup($1,$2,$3,$4,'failed','DELETE_FAILED',$5)",
          [orgId, sourceId, path, first.rows[0].cleanup_token, recoveryOwnerId],
        ),
      /token does not match/i,
    );
    const completed = await pg.query<{ outcome: string }>(
      "select * from public.complete_unattached_esign_template_source_cleanup($1,$2,$3,$4,'deleted',null,$5)",
      [orgId, sourceId, path, reclaimed.rows[0].cleanup_token, recoveryOwnerId],
    );
    expect(completed.rows[0].outcome).toBe("deleted");
    const replay = await pg.query<{ outcome: string; cleanup_token: string | null }>(
      "select * from public.claim_unattached_esign_template_source_cleanup($1,$2,$3,$4)",
      [orgId, sourceId, path, creatorId],
    );
    expect(replay.rows[0]).toMatchObject({
      outcome: "already_deleted",
      cleanup_token: null,
    });
  });

  it("quarantines failed cleanup from delayed source and provider work until cleanup retry converges", async () => {
    await connectIntegration(orgId, creatorId, "account-a");
    const source = await prepareAndVerify();
    const firstClaim = await pg.query<{ cleanup_token: string }>(
      "select * from public.claim_unattached_esign_template_source_cleanup($1,$2,$3,$4)",
      [orgId, source.id, source.path, creatorId],
    );
    await pg.query(
      "select * from public.complete_unattached_esign_template_source_cleanup($1,$2,$3,$4,'failed','DELETE_AMBIGUOUS',$5)",
      [orgId, source.id, source.path, firstClaim.rows[0].cleanup_token, creatorId],
    );

    await expectDbError(
      () =>
        pg.query(
          `select public.record_verified_esign_template_source(
             $1,$2,$3,'agreement.pdf',1024,'application/pdf',repeat('b',64),$4
           )`,
          [orgId, source.id, source.path, recoveryOwnerId],
        ),
      /conflicts with the existing source/i,
    );
    await expectDbError(
      () =>
        pg.query(
          `select * from public.verify_esign_template_source_upload(
             $1,$2,$3,1024,'application/pdf',repeat('b',64),$4
           )`,
          [orgId, source.id, source.path, recoveryOwnerId],
        ),
      /being cleaned up/i,
    );
    await expectDbError(
      () => consumeDraft(source.id, recoveryOwnerId),
      /verified template source not found/i,
    );

    const forcedTemplateId = crypto.randomUUID();
    await resetRole();
    await pg.query(
      `insert into public.esign_templates (
         id, org_id, name, document_type, seller_role, signer_roles,
         merge_field_names, staging_source_id, source_filename,
         source_size_bytes, source_content_type, source_sha256, staging_path,
         lifecycle_state, provider_create_state, created_by, updated_by
       ) values (
         $1,$2,'Delayed draft','purchase_agreement','Seller',
         '[{"name":"Seller","order":0},{"name":"seller","order":1}]'::jsonb,
         array['seller_name','property_address','offer_price','closing_date','earnest_money'],
         $3,'agreement.pdf',1024,'application/pdf',repeat('b',64),$4,
         'preparing','unstarted',$5,$5
       )`,
      [forcedTemplateId, orgId, source.id, source.path, creatorId],
    );
    await setRole("service_role");
    await expectDbError(
      () =>
        pg.query(
          "select * from public.claim_esign_template_provider_create($1,$2,$3,$4)",
          [orgId, forcedTemplateId, source.id, recoveryOwnerId],
        ),
      /source is unavailable/i,
    );

    await resetRole();
    await pg.query("delete from public.esign_templates where id=$1", [forcedTemplateId]);
    await setRole("service_role");
    const retry = await pg.query<{ outcome: string; cleanup_token: string }>(
      "select * from public.claim_unattached_esign_template_source_cleanup($1,$2,$3,$4)",
      [orgId, source.id, source.path, recoveryOwnerId],
    );
    expect(retry.rows[0].outcome).toBe("claimed");
    expect(retry.rows[0].cleanup_token).not.toBe(firstClaim.rows[0].cleanup_token);
    await deleteStagingObject(source.path);
    const completed = await pg.query<{ outcome: string; cleanup_state: string }>(
      "select * from public.complete_unattached_esign_template_source_cleanup($1,$2,$3,$4,'deleted',null,$5)",
      [orgId, source.id, source.path, retry.rows[0].cleanup_token, recoveryOwnerId],
    );
    expect(completed.rows[0]).toMatchObject({
      outcome: "deleted",
      cleanup_state: "deleted",
    });
    const replay = await pg.query<{ outcome: string; cleanup_token: string | null }>(
      "select * from public.claim_unattached_esign_template_source_cleanup($1,$2,$3,$4)",
      [orgId, source.id, source.path, creatorId],
    );
    expect(replay.rows[0]).toMatchObject({
      outcome: "already_deleted",
      cleanup_token: null,
    });
  });

  it("requires a provider account and keeps service-role latest-request access coherent", async () => {
    await setRole("service_role");
    await expectDbError(
      () =>
        pg.query(
          `select public.upsert_org_esign_integration(
             $1,'test-api-key-1234','1234','test-client','',repeat('a',64),$2,
             'test-encryption-key'
           )`,
          [orgId, creatorId],
        ),
      /provider account/i,
    );
    const bypass = await pg.query<{ rolbypassrls: boolean }>(
      "select rolbypassrls from pg_roles where rolname='service_role'",
    );
    expect(bypass.rows[0].rolbypassrls).toBe(true);
    const propertyId = crypto.randomUUID();
    const latest = await pg.query(
      "select * from public.get_latest_esign_requests_for_properties($1,$2::uuid[])",
      [orgId, [propertyId]],
    );
    expect(latest.rows).toEqual([]);
  });
});
