import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const roles = ['anon', 'authenticated', 'service_role'];
const ops = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const triggerPre = ['trg_messages_fill_sms_conversation_id', 'guard_training_messages', 'messages_reject_dnc_locked_read'];
const triggerPost = [...triggerPre, 'zzz_inbox_guard_inbound_revision_insert', 'zzz_inbox_guard_inbound_revision_update', 'inbox_capture_inbound_head', 'zzzzz_inbox_message_direct', 'zzzzzzzz_inbox_operation_target'];
const pin = phase => JSON.parse(readFileSync(new URL(`./expected/privileges.${phase}.json`, import.meta.url), 'utf8'));

export async function checkPrivileges(db, phase) {
  const checks = [];
  const check = async (id, fn) => { try { checks.push({ id, verdict: 'PASS', detail: await fn() }); } catch (error) { checks.push({ id, verdict: 'FAIL', error: String(error.message ?? error) }); } };
  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  await check('PIN_TRIGGERS', async () => {
    const rows = await q("select t.tgname,t.tgenabled from pg_trigger t where t.tgrelid='public.messages'::regclass and not t.tgisinternal order by t.tgname");
    assert.deepEqual(rows.map(r => r.tgname).sort(), (phase === 'post' ? triggerPost : triggerPre).sort());
    assert(rows.every(r => r.tgenabled === 'O'));
    return rows;
  });
  await check('PIN_BASE_GRANTS', async () => {
    const names = ['messages', 'contacts', 'properties', 'memberships', 'lead_events'];
    const rows = await q("select n,role,op,has_table_privilege(role,'public.'||n,op) as allowed from unnest($1::text[]) n cross join unnest($2::text[]) role cross join unnest($3::text[]) op order by n,role,op", [names, roles, ops]);
    for (const row of rows) {
      if (['messages', 'contacts', 'properties', 'memberships'].includes(row.n)) assert.equal(row.allowed, row.role !== 'anon', JSON.stringify(row));
      if (row.n === 'lead_events') assert.equal(row.allowed, row.role === 'authenticated' ? row.op === 'SELECT' : row.role === 'service_role' && ['SELECT', 'INSERT'].includes(row.op), JSON.stringify(row));
    }
    const metrics = await q("select role,has_function_privilege(role,'public.outbound_sms_metrics(uuid,uuid,timestamptz,timestamptz,timestamptz)','EXECUTE') as allowed from unnest($1::text[]) role", [roles]);
    for (const row of metrics) assert.equal(row.allowed, row.role === 'authenticated', JSON.stringify(row));
    return { tables: rows, metrics };
  });
  if (phase === 'post') {
    const expected = pin('post');
    await check('PIN_FUNCTIONS', async () => {
      const rows = await q("select n.nspname||'.'||p.proname as name,p.prosecdef as secdef,pg_get_userbyid(p.proowner) as owner,coalesce((select regexp_replace(x,'^search_path=','') from unnest(p.proconfig) x where x like 'search_path=%'),'') as search_path,p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname like 'inbox_%' or (n.nspname='public' and p.proname like 'inbox_%') order by 1,5");
      assert.deepEqual([...new Set(rows.map(r => r.name))].sort(), Object.keys(expected.functions).sort());
      for (const row of rows) {
        const want = expected.functions[row.name];
        assert.equal(row.secdef, want.secdef, row.name); assert.equal(row.owner, want.owner, row.name);
        assert.equal(row.search_path.replaceAll(' ', ''), want.search_path.replaceAll(' ', ''), row.name);
        const grants = await q("select role,has_function_privilege(role,$1,'EXECUTE') as allowed from unnest($2::text[]) role", [row.signature, roles]);
        assert.deepEqual(grants.filter(r => r.allowed).map(r => r.role).sort(), want.execute, row.name);
      }
      assert.equal(expected.functions['public.inbox_guard_inbound_revision'].secdef, false);
      return { count: rows.length };
    });
    await check('PIN_RELATIONS', async () => {
      const rows = await q("select n.nspname||'.'||c.relname as name,pg_get_userbyid(c.relowner) as owner,c.relrowsecurity as rls,(select count(*)::int from pg_policy p where p.polrelid=c.oid) as policies,c.oid::regclass::text as relation from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in ('r','p') and (n.nspname like 'inbox_%' or (n.nspname='public' and c.relname='inbox_inbound_heads')) order by 1");
      const expectedTables = Object.keys(expected.relation_owners).filter(k => k.startsWith('table:')).map(k => k.slice(6)).sort();
      assert.deepEqual(rows.map(r => r.name), expectedTables);
      for (const row of rows) {
        assert.equal(row.owner, 'postgres'); assert.equal(row.rls, true); assert.equal(row.policies, 0);
        const perms = await q("select role,op,has_table_privilege(role,$1,op) as allowed from unnest($2::text[]) role cross join unnest($3::text[]) op", [row.relation, roles, ops]);
        assert(perms.every(r => !r.allowed), row.name);
        const columns = await q("select grantee,column_name from information_schema.column_privileges where table_schema=$1 and table_name=$2 and grantee=any($3::text[])", row.name.split('.').concat([roles]));
        assert.equal(columns.length, 0, row.name);
      }
      return { count: rows.length };
    });
    await check('PIN_SCHEMAS_ROLLOUT_ROLES', async () => {
      const schemas = Object.keys(expected.relation_owners).filter(k => k.startsWith('schema:')).map(k => k.slice(7));
      for (const schema of schemas) {
        const perms = await q('select role,has_schema_privilege(role,$1,\'USAGE\') as allowed from unnest($2::text[]) role', [schema, roles]);
        const authAllowed = ['inbox_authenticated_detail', 'inbox_capture_boundary', 'inbox_read', 'inbox_action_api'].includes(schema);
        for (const p of perms) assert.equal(p.allowed, p.role === 'authenticated' && authAllowed, `${schema}:${p.role}`);
      }
      const rollout = await q('select serving_enabled from inbox_control.rollout'); assert.equal(rollout.length, 1); assert.equal(rollout[0].serving_enabled, false);
      const workers = await q("select rolname,rolcanlogin from pg_roles where rolname in ('inbox_action_worker','inbox_reply_send_worker','inbox_projection_worker') order by rolname");
      assert.deepEqual(workers, [{ rolname: 'inbox_action_worker', rolcanlogin: false }, { rolname: 'inbox_reply_send_worker', rolcanlogin: false }]);
      return { schemas: schemas.length, rollout: false, workers };
    });
  } else {
    await check('PIN_PRE_ABSENCE', async () => {
      const rows = await q("select to_regclass('public.inbox_inbound_heads') as head,to_regclass('inbox_control.rollout') as rollout");
      assert.equal(rows[0].head, null); assert.equal(rows[0].rollout, null);
      return rows[0];
    });
  }
  return checks;
}
