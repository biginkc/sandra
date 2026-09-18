import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";

const { Client } = pg;
const BMH_ORG_ID = "00000000-0000-0000-0000-000000000bbb";
const OTHER_ORG_ID = "10000000-0000-4000-8000-000000000012";
const migrationPath = new URL(
  "../supabase/migrations/20260917200000_sms_opening_identity.sql",
  import.meta.url,
);
const seedTemplateSql = readFileSync(
  new URL("../supabase/migrations/040_seed_bmh_sms_templates.sql", import.meta.url),
  "utf8",
);
const seedOpenerSql = readFileSync(
  new URL("../supabase/migrations/042_seed_opener_templates.sql", import.meta.url),
  "utf8",
);
const migrationSql = readFileSync(migrationPath, "utf8");

const additionalChanges = [
  [
    "Opener: FSBO + start a conversation",
    "Hi, this is {{my_first_name | Mel}} with BMH Group. I'm interested in {{property_address | your property}}. Would you be open to chatting about it?",
    "Hi, this is Mel with BMH. I'm interested in {{property_address | your property}}. Would you be open to chatting about it?",
  ],
  [
    "Awkward owner check",
    "{{first_name | Hey there}}, sorry to bother. I think you might own {{property_address}}? - {{my_first_name}}",
    "Hi {{first_name | there}}, I'm Mel with BMH, a local home buyer. Do you own {{property_address}}?",
  ],
  [
    "First-message identification",
    "{{my_first_name}} with {{company_name}}. Reply STOP to opt out.",
    "Mel with BMH. Reply STOP to opt out.",
  ],
  [
    "Agent: Active listing post-VM",
    "Hi {{first_name | there}}, {{my_first_name}} here, left you a VM on your listing at {{property_address}}. Active cash buyer locally, got 2 min?",
    "Hi {{first_name | there}}, Mel with BMH here. I left you a VM on your listing at {{property_address}}. We're local cash buyers. Got 2 min?",
  ],
  [
    "Opener: FSBO + listing reference",
    "Hi, this is {{my_first_name | Mel}} with BMH Group. I saw your listing for {{property_address | your property}} and wanted to reach out. Are you still looking for a buyer?",
    "Hi, this is Mel with BMH. I saw your listing for {{property_address | your property}} and wanted to reach out. Are you still looking for a buyer?",
  ],
  [
    "Random + owner check",
    "Hi {{first_name | there}}, I know this is random. Looking for the owner of {{property_address}}. That you?",
    "Hi {{first_name | there}}, Mel with BMH here. We buy homes locally. Are you the owner of {{property_address}}?",
  ],
  [
    "Soft tied-to check",
    "Hey {{first_name | there}}, quick one - are you still tied to {{property_address}}? - {{my_first_name}}",
    "Hey {{first_name | there}}, Mel with BMH here. We're local home buyers. Are you still tied to {{property_address}}?",
  ],
  [
    "Opener: FSBO + owner confirmation",
    "Hi, this is {{my_first_name | Mel}} with BMH Group. I'm reaching out about {{property_address | your property}}. Are you the owner?",
    "Hi, this is Mel with BMH. I'm reaching out about {{property_address | your property}}. Are you the owner?",
  ],
  [
    "Agent: Expired listing",
    "Hi {{first_name}}, saw {{property_address}} expired. Active cash buyer in {{market | the area}}, interested if your seller is still open.",
    "Hi {{first_name | there}}, I'm Mel with BMH. We're local cash buyers. I saw {{property_address}} expired. Is your seller still open to an offer?",
  ],
  [
    "Owner check (consensus)",
    "Are you the owner of {{property_address}}?",
    "Mel with BMH here. We're local home buyers. Are you the owner of {{property_address}}?",
  ],
  [
    "Opener: FSBO + still available",
    "Hi, this is {{my_first_name | Mel}} with BMH Group. I'm interested in {{property_address | your property}}. Is it still available?",
    "Hi, this is Mel with BMH. I'm interested in {{property_address | your property}}. Is it still available?",
  ],
  [
    "Opener: FSBO + text preference",
    "Hi, this is {{my_first_name | Mel}} with BMH Group. Your listing for {{property_address | your property}} caught my attention. Is text a good way to connect about it?",
    "Hi, this is Mel with BMH. Your listing for {{property_address | your property}} caught my attention. Is text a good way to connect about it?",
  ],
  [
    "Local sender + still own",
    "{{first_name | Hi}}, {{my_first_name}} here in {{city | your area}}. Quick question: still own the place at {{property_address}}?",
    "Hi {{first_name | there}}, I'm Mel with BMH. We're local home buyers. Do you still own {{property_address}}?",
  ],
];

const schemaSql = `
  create extension if not exists pgcrypto;
  create schema if not exists public;
  create table public.organizations (
    id uuid primary key,
    name text not null
  );
  create table public.sms_templates (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references public.organizations(id),
    name text not null,
    content text not null,
    category text not null,
    system_managed boolean not null default false,
    deleted_at timestamptz,
    unique (org_id, name)
  );
  create table public.sequences (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references public.organizations(id),
    name text not null,
    unique (org_id, name)
  );
  create table public.sequence_steps (
    id uuid primary key default gen_random_uuid(),
    sequence_id uuid not null references public.sequences(id),
    step_index integer not null,
    action_type text not null,
    template_body text
  );
  create table public.messages (
    id uuid primary key default gen_random_uuid(),
    org_id uuid not null references public.organizations(id),
    status text not null,
    body text not null
  );
`;

function targetUrl(base, database) {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

async function query(client, text, values) {
  return (await client.query(text, values)).rows;
}

async function run() {
  const baseUrl = process.env.SMS_OPENING_IDENTITY_VERIFY_DB_URL ??
    process.env.SUPABASE_LOCAL_DB_URL;
  assert(baseUrl, "Set SUPABASE_LOCAL_DB_URL or SMS_OPENING_IDENTITY_VERIFY_DB_URL to a local disposable PostgreSQL server.");
  assert(["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname),
    "Refusing to rehearse against a non-local database.");
  const database = `sms_opening_identity_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: targetUrl(baseUrl, "postgres") });
  let target;
  let created = false;
  try {
    await admin.connect();
    await admin.query(`create database "${database}"`);
    created = true;
    target = new Client({ connectionString: targetUrl(baseUrl, database) });
    await target.connect();
    await target.query(schemaSql);
    await query(target, "insert into public.organizations (id, name) values ($1, 'BMH Group'), ($2, 'Other')", [BMH_ORG_ID, OTHER_ORG_ID]);
    await target.query(seedTemplateSql);
    await target.query(seedOpenerSql);

    for (const [name, oldContent] of additionalChanges) {
      const isSeeded = (await query(target, "select 1 from public.sms_templates where org_id = $1 and name = $2", [BMH_ORG_ID, name])).length > 0;
      if (!isSeeded) {
        await query(target, "insert into public.sms_templates (org_id, name, content, category) values ($1, $2, $3, 'Outreach - Homeowner')", [BMH_ORG_ID, name, oldContent]);
      }
    }

    const sequenceRows = await query(target, "insert into public.sequences (org_id, name) values ($1, 'First touch new lead') returning id", [BMH_ORG_ID]);
    await query(target, `insert into public.sequence_steps (sequence_id, step_index, action_type, template_body)
      values ($1, 0, 'send_sms', $2)`, [sequenceRows[0].id, "{{#if first_name}}Hi {{first_name}}, {{/if}}this is {{my_first_name}} with {{company_name}}. I saw your property at {{property_address}}. Would you consider a cash offer? {{opt_out}}"]);

    await query(target, "insert into public.sms_templates (org_id, name, content, category) values ($1, $2, $3, 'Opener - Homeowner')", [OTHER_ORG_ID, "Opener: still owner (casual)", "Hey {{first_name | there}}, are you still the owner over on {{property_address}}?"]);
    const queuedBody = "queued copy must remain unchanged";
    const queuedRows = await query(target, "insert into public.messages (org_id, status, body) values ($1, 'queued', $2) returning id", [BMH_ORG_ID, queuedBody]);

    const before = await query(target, "select id, name, content, category, deleted_at from public.sms_templates where org_id = $1 order by name", [BMH_ORG_ID]);
    const beforeIds = new Map(before.map((row) => [row.name, row.id]));
    assert.equal(before.filter((row) => row.category === "Opener - Homeowner").length, 15);
    assert.equal(additionalChanges.length, 13);

    await target.query(migrationSql);
    const firstAfter = await query(target, "select id, name, content, category, deleted_at from public.sms_templates where org_id = $1", [BMH_ORG_ID]);
    assert.equal(firstAfter.length, before.length, "migration must preserve template count");
    for (const [name, , newContent] of additionalChanges) {
      const row = firstAfter.find((candidate) => candidate.name === name);
      assert.ok(row, `missing additional template ${name}`);
      assert.equal(row.content, newContent, `additional template ${name} was not updated`);
    }
    const openerRows = await query(target, "select content from public.sms_templates where org_id = $1 and category = 'Opener - Homeowner' and deleted_at is null", [BMH_ORG_ID]);
    assert.equal(openerRows.length, 15);
    assert.equal(openerRows.filter((row) => row.content.includes("Mel with BMH")).length, 15);
    for (const row of firstAfter) assert.equal(row.id, beforeIds.get(row.name), `template id changed for ${row.name}`);

    const firstStep = (await query(target, "select template_body from public.sequence_steps where sequence_id = $1 and step_index = 0", [sequenceRows[0].id]))[0];
    assert.equal(firstStep.template_body, "{{#if first_name}}Hi {{first_name}}, {{/if}}this is Mel with BMH. I saw your property at {{property_address}}. Would you consider a cash offer? {{opt_out}}");
    const otherOrg = (await query(target, "select content from public.sms_templates where org_id = $1 and name = $2", [OTHER_ORG_ID, "Opener: still owner (casual)"]))[0];
    assert.equal(otherOrg.content, "Hey {{first_name | there}}, are you still the owner over on {{property_address}}?");
    assert.equal((await query(target, "select status, body from public.messages where id = $1", [queuedRows[0].id]))[0].body, queuedBody);

    const customName = "Opener: random question";
    const deletedName = "Opener: still linked";
    await query(target, "update public.sms_templates set content = 'custom copy', deleted_at = null where org_id = $1 and name = $2", [BMH_ORG_ID, customName]);
    await query(target, "update public.sms_templates set content = 'deleted historical copy', deleted_at = now() where org_id = $1 and name = $2", [BMH_ORG_ID, deletedName]);
    await target.query(migrationSql);
    const rerun = await query(target, "select name, content, deleted_at from public.sms_templates where org_id = $1 and name in ($2, $3)", [BMH_ORG_ID, customName, deletedName]);
    assert.equal(rerun.find((row) => row.name === customName).content, "custom copy");
    assert.equal(rerun.find((row) => row.name === deletedName).content, "deleted historical copy");
    assert.ok(rerun.find((row) => row.name === deletedName).deleted_at);
    assert.equal((await query(target, "select body from public.messages where id = $1", [queuedRows[0].id]))[0].body, queuedBody);
    assert.equal((await query(target, "select template_body from public.sequence_steps where sequence_id = $1 and step_index = 0", [sequenceRows[0].id]))[0].template_body, "{{#if first_name}}Hi {{first_name}}, {{/if}}this is Mel with BMH. I saw your property at {{property_address}}. Would you consider a cash offer? {{opt_out}}");
    console.log("Verified: 28 present template rows + first-touch step updated, IDs/counts preserved, rerun is safe, and custom/deleted/other-org/queued rows are unchanged.");
  } finally {
    if (target) await target.end().catch(() => {});
    if (created) await admin.query(`drop database "${database}"`).catch(() => {});
    await admin.end().catch(() => {});
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
