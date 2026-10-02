// Local-only: undo migrations 20261002110000/110050 on the disposable stack so
// the real `supabase db push` can be re-run against a seeded 50k/250k dataset.
import pg from "pg";
import { assertSandboxTarget, SANDBOX } from "./assert-sandbox-target.mjs";
await assertSandboxTarget({ workdir: undefined });
const url = SANDBOX.url; // never an env override
const c = new pg.Client({ connectionString: url });
await c.connect();
const early = "  if tg_op = 'UPDATE' and public.properties_filter_cache_only_change(old, new) then\n    return new;\n  end if;\n";
await c.query("begin");
for (const fn of ["properties_true_dnc_lock_guard", "serialize_property_safety_before_csv_consent"]) {
  const { rows } = await c.query("select pg_get_functiondef($1::regproc) d", [`public.${fn}`]);
  const def = rows[0].d;
  if (def.includes(early)) await c.query(def.replace(early, ""));
}
for (const t of ["messages", "tasks", "property_lists", "property_tags"])
  for (const ev of ["insert", "update", "delete"]) await c.query(`drop trigger if exists zz_${t}_filter_cache_${ev} on public.${t}`);
await c.query("drop trigger if exists a_properties_filter_cache_pin on public.properties");
await c.query("drop trigger if exists zz_properties_filter_cache_org_change on public.properties");
await c.query(`drop function if exists public.refresh_property_filter_cache(uuid[]), public.trg_messages_refresh_filter_cache(), public.trg_tasks_refresh_filter_cache(), public.trg_property_lists_refresh_filter_cache(), public.trg_property_tags_refresh_filter_cache(), public.trg_properties_org_change_refresh_filter_cache(), public.properties_filter_cache_pin(), public.properties_filter_cache_only_change(public.properties, public.properties)`);
await c.query("alter table public.properties drop column if exists has_inbound_message, drop column if exists has_outbound_message, drop column if exists has_unread_inbound, drop column if exists has_open_tasks, drop column if exists filter_list_ids, drop column if exists filter_tag_ids, drop column if exists filter_list_count");
await c.query("delete from supabase_migrations.schema_migrations where version in ('20261002110000','20261002110050','20261002110055')");
await c.query("alter table public.properties reset (fillfactor)");
await c.query("commit");
console.log("reverted");
await c.end();
