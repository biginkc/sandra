import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { requireLoopbackPostgresUrl } from "@/lib/testing/loopback-postgres-url";

/**
 * Template auto-send approval + outcome mapping (20261008170000). Local-only;
 * each test runs in a transaction that is rolled back. Requires a DB with the
 * chain through 20261008144200 applied (the migration itself is applied here
 * so the rollback can be exercised too).
 */
const url = requireLoopbackPostgresUrl(
  process.env.TEST_SUPABASE_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54329/postgres",
);
const strip = (s: string) => s.replace(/^\s*begin;\s*$/gim, "").replace(/^\s*commit;\s*$/gim, "");
const MIGRATION = strip(readFileSync(path.join(__dirname, "20261008170000_auto_reply_templates.sql"), "utf8"));
const ROLLBACK = strip(
  readFileSync(path.join(__dirname, "../rollbacks/20261008170000_auto_reply_templates.sql"), "utf8"),
);

const db = new Client({ connectionString: url });
let orgId: string;
let templateId: string;
const users = {} as Record<"owner" | "acq" | "plain", string>;
const TEXT = "Hi {{first_name | there}}, thanks for letting us know.";

beforeAll(async () => {
  await db.connect();
});
afterAll(async () => {
  await db.end();
});

async function addMember(key: keyof typeof users, role: "owner" | "member", acq = false) {
  const id = randomUUID();
  users[key] = id;
  await db.query(`insert into auth.users (id, email) values ($1, $2)`, [id, `${key}-${id}@test.local`]);
  await db.query(
    `insert into public.memberships (org_id, user_id, role, access_status, acquisitions_enabled)
     values ($1, $2, $3, 'active', $4)`,
    [orgId, id, role, acq],
  );
}

async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await db.query("savepoint as_user");
  await db.query("set local role authenticated");
  await db.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
  try {
    const out = await fn();
    await db.query("reset role");
    await db.query("release savepoint as_user");
    return out;
  } catch (e) {
    await db.query("rollback to savepoint as_user");
    await db.query("reset role");
    throw e;
  }
}

const approve = (approved: boolean, expected: string | null) => () =>
  db.query(`select public.fn_set_template_auto_send_approval($1, $2, $3) as r`, [templateId, approved, expected]);

const setMapping = (outcome: string, intent: string | null, tpl = templateId, extra: unknown[] = [100, true, null, false]) => () =>
  db.query(`select public.fn_set_auto_reply_template($1, $2, $3, $4, $5, $6, $7, $8) as r`, [
    orgId,
    outcome,
    intent,
    tpl,
    ...extra,
  ]);

beforeEach(async () => {
  await db.query("begin");
  orgId = randomUUID();
  await db.query("insert into public.organizations (id, name) values ($1, 'auto-reply')", [orgId]);
  await db.query("set local session_replication_role = replica");
  await addMember("owner", "owner");
  await addMember("acq", "member", true);
  await addMember("plain", "member");
  await db.query("set local session_replication_role = origin");
  await db.query(MIGRATION);
  const t = await db.query(
    `insert into public.sms_templates (org_id, name, content) values ($1, 'ack', $2) returning id`,
    [orgId, TEXT],
  );
  templateId = t.rows[0].id;
});
afterEach(async () => {
  await db.query("rollback");
});

const row = async () =>
  (await db.query(`select * from public.sms_templates where id = $1`, [templateId])).rows[0];

describe("template approval", () => {
  it("nothing is approved by default", async () => {
    const r = await row();
    expect(r.approved_for_auto_send).toBe(false);
    expect(r.approved_by).toBeNull();
    expect(r.approved_at).toBeNull();
    expect(r.approved_content).toBeNull();
  });

  it("an owner approves the exact text; approved_by/at and the audit event are recorded", async () => {
    await asUser(users.owner, approve(true, TEXT));
    const r = await row();
    expect(r.approved_for_auto_send).toBe(true);
    expect(r.approved_by).toBe(users.owner);
    expect(r.approved_at).toBeInstanceOf(Date);
    expect(r.approved_content).toBe(TEXT);
    const ev = await db.query(`select action, content, actor from public.sms_template_approval_events where template_id = $1`, [templateId]);
    expect(ev.rows).toEqual([{ action: "approved", content: TEXT, actor: users.owner }]);
  });

  it("refuses when the text on screen is not the stored text", async () => {
    await expect(asUser(users.owner, approve(true, `${TEXT} `))).rejects.toThrow(/CONTENT_CHANGED/);
    await expect(asUser(users.owner, approve(true, null))).rejects.toThrow(/CONTENT_CHANGED/);
    expect((await row()).approved_for_auto_send).toBe(false);
  });

  it("only an owner may approve: acquisitions and plain members are FORBIDDEN", async () => {
    await expect(asUser(users.acq, approve(true, TEXT))).rejects.toThrow(/FORBIDDEN/);
    await expect(asUser(users.plain, approve(true, TEXT))).rejects.toThrow(/FORBIDDEN/);
    expect((await row()).approved_for_auto_send).toBe(false);
  });

  it("the approval columns cannot be written around the RPC, even by an owner", async () => {
    for (const sql of [
      `update public.sms_templates set approved_for_auto_send = true, approved_at = now(), approved_content = content where id = $1`,
      `update public.sms_templates set approved_by = '${users.owner}' where id = $1`,
    ]) {
      await expect(asUser(users.owner, () => db.query(sql, [templateId]))).rejects.toThrow(/APPROVAL_RPC_ONLY/);
    }
    await expect(
      asUser(users.owner, () =>
        db.query(
          `insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_at, approved_content)
           values ($1, 'sneaky', 'x', true, now(), 'x')`,
          [orgId],
        ),
      ),
    ).rejects.toThrow(/APPROVAL_RPC_ONLY/);
  });

  it("editing the text revokes the approval and records it", async () => {
    await asUser(users.owner, approve(true, TEXT));
    await db.query(`update public.sms_templates set content = 'Different text' where id = $1`, [templateId]);
    const r = await row();
    expect(r.approved_for_auto_send).toBe(false);
    expect(r.approved_by).toBeNull();
    expect(r.approved_content).toBeNull();
    const ev = await db.query(`select action, content from public.sms_template_approval_events where template_id = $1 order by created_at, action`, [templateId]);
    expect(ev.rows.map((e) => e.action).sort()).toEqual(["approved", "revoked_text_changed"]);
  });

  it("deleting the template revokes the approval", async () => {
    await asUser(users.owner, approve(true, TEXT));
    await db.query(`update public.sms_templates set deleted_at = now() where id = $1`, [templateId]);
    expect((await row()).approved_for_auto_send).toBe(false);
  });

  it("renaming or recategorising keeps the approval", async () => {
    await asUser(users.owner, approve(true, TEXT));
    await db.query(`update public.sms_templates set name = 'renamed', category = 'Other' where id = $1`, [templateId]);
    expect((await row()).approved_for_auto_send).toBe(true);
  });

  it("an owner can revoke", async () => {
    await asUser(users.owner, approve(true, TEXT));
    await asUser(users.owner, approve(false, null));
    const r = await row();
    expect(r.approved_for_auto_send).toBe(false);
    expect(r.approved_by).toBeNull();
    const ev = await db.query(`select action from public.sms_template_approval_events where template_id = $1`, [templateId]);
    expect(ev.rows.map((e) => e.action).sort()).toEqual(["approved", "revoked"]);
  });

  it("the audit trail is owner-readable only", async () => {
    await asUser(users.owner, approve(true, TEXT));
    const read = () => db.query(`select id from public.sms_template_approval_events where org_id = $1`, [orgId]);
    expect((await asUser(users.owner, read)).rows).toHaveLength(1);
    expect((await asUser(users.acq, read)).rows).toHaveLength(0);
    expect((await asUser(users.plain, read)).rows).toHaveLength(0);
  });
});

describe("auto_reply_templates", () => {
  it("owner maps an outcome to a template; a second call with the same key updates, not duplicates", async () => {
    const first = (await asUser(users.owner, setMapping("nurture", null))).rows[0].r;
    expect(first).toMatchObject({ ok: true, deleted: false });
    await asUser(users.owner, setMapping("nurture", null, templateId, [50, false, null, false]));
    const rows = (await db.query(`select priority, active, created_by, updated_by from public.auto_reply_templates where org_id = $1`, [orgId])).rows;
    expect(rows).toEqual([{ priority: 50, active: false, created_by: users.owner, updated_by: users.owner }]);
  });

  it("is owner-only to write; direct table writes are not granted", async () => {
    await expect(asUser(users.acq, setMapping("nurture", null))).rejects.toThrow(/FORBIDDEN/);
    await expect(asUser(users.plain, setMapping("nurture", null))).rejects.toThrow(/FORBIDDEN/);
    await expect(
      asUser(users.owner, () =>
        db.query(
          `insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'nurture', $2)`,
          [orgId, templateId],
        ),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("owner and Acquisitions read; a plain member sees nothing; service_role reads", async () => {
    await asUser(users.owner, setMapping("not_interested", "negative"));
    const read = () => db.query(`select id from public.auto_reply_templates where org_id = $1`, [orgId]);
    expect((await asUser(users.owner, read)).rows).toHaveLength(1);
    expect((await asUser(users.acq, read)).rows).toHaveLength(1);
    expect((await asUser(users.plain, read)).rows).toHaveLength(0);
    await db.query("savepoint s");
    await db.query("set local role service_role");
    try {
      expect((await read()).rows).toHaveLength(1);
    } finally {
      await db.query("rollback to savepoint s");
      await db.query("reset role");
    }
  });

  it("rejects outcomes that must never auto-reply, unknown intents, and foreign or deleted templates", async () => {
    for (const outcome of ["opted_out", "dnc", "wrong_number", "unclear", "bogus"]) {
      await expect(asUser(users.owner, setMapping(outcome, null))).rejects.toThrow(/INVALID_OUTCOME/);
    }
    await expect(asUser(users.owner, setMapping("nurture", "angry"))).rejects.toThrow(/INVALID_REPLY_INTENT/);
    await expect(asUser(users.owner, setMapping("nurture", null, randomUUID()))).rejects.toThrow(/TEMPLATE_NOT_FOUND/);
    await db.query(`update public.sms_templates set deleted_at = now() where id = $1`, [templateId]);
    await expect(asUser(users.owner, setMapping("nurture", null))).rejects.toThrow(/TEMPLATE_NOT_FOUND/);
  });

  it("the table check constraint also refuses a bad outcome from any other writer", async () => {
    await expect(
      db.query(`insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, 'opted_out', $2)`, [orgId, templateId]),
    ).rejects.toThrow(/auto_reply_templates_outcome_check/);
  });

  it("owner deletes a mapping", async () => {
    const id = (await asUser(users.owner, setMapping("nurture", null))).rows[0].r.mappingId;
    await asUser(users.owner, setMapping("nurture", null, templateId, [100, true, id, true]));
    expect((await db.query(`select 1 from public.auto_reply_templates where org_id = $1`, [orgId])).rows).toHaveLength(0);
  });

  it("deleting a template row cascades its mappings", async () => {
    await asUser(users.owner, setMapping("nurture", null));
    await db.query(`delete from public.sms_templates where id = $1`, [templateId]);
    expect((await db.query(`select 1 from public.auto_reply_templates where org_id = $1`, [orgId])).rows).toHaveLength(0);
  });
});

describe("rollback", () => {
  it("removes the feature and the migration re-applies cleanly", async () => {
    await db.query(ROLLBACK);
    expect(
      (await db.query(`select to_regclass('public.auto_reply_templates') as t, to_regprocedure('public.fn_set_auto_reply_template(uuid, text, text, uuid, integer, boolean, uuid, boolean)') as f`)).rows[0],
    ).toEqual({ t: null, f: null });
    const cols = await db.query(
      `select column_name from information_schema.columns where table_name = 'sms_templates' and column_name like 'approved%'`,
    );
    expect(cols.rows).toHaveLength(0);
    await db.query(MIGRATION);
  });
});
