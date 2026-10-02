# Search page §0 spike — results

Run 2026-10-02 against hosted TEST project `ncsngxlcyxylaeskiteu` (PostgreSQL 17.6), `@supabase/supabase-js` and `@supabase/postgrest-js` 2.104.0, authenticated user client (owner of BMH org, JWT via `createOrgUser`). PostgREST server version is not exposed by the hosted endpoint (no version header).

Throwaway objects (all dropped; verified zero left): `spike_search_properties_<id>(q text) returns setof public.properties` (SECURITY DEFINER, `search_path = public, pg_temp`, membership gate on `auth.uid()`, `address ILIKE`), `spike_has_inbound_<id>(public.properties) returns boolean` (stable SQL, invoker), `spike_slow_<id>(q)` (pg_sleep(15)). Fixtures: 4 properties (A: inbound+outbound msgs + homeowner contact; B: outbound only; C: none; D: `outreach_dispo='opted_out'`), 1 contact, 1 list (A, C), 1 auth user + membership. All deleted. Suite advisory lock held for the run. Spike SQL not committed.

| Item | Result | Evidence |
|---|---|---|
| a | PASS | `rpc(FN,{q},{count:'exact',head:true}).select('id')` → status 200, `count: 4`, `data: null`, no error |
| b | PASS | `rpc(FN,{q}).select('id, homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1), contacted_messages:messages!inner(direction)').order('address').range(0,24)` → only A and B returned (C, D dropped, so `!inner` filters); A's homeowner `phone_1` returned, A has 2 messages. Without `!inner`, all 4 rows. |
| c | PASS | On both `from('properties')` and the rpc builder: `.eq(fn,true)` → {A}; `.eq(fn,false)` and `.not(fn,'eq',true)` → {B,C,D}; `.or('fn.eq.true,outreach_dispo.in.(opted_out,dnc)')` → {A,D}. |
| d | PARTIAL | Plain column block (`outreach_dispo` any / not) through `applyFilters` on the rpc builder: PASS. List block with `filterSelectFragment` (`list_filter:property_lists!inner(list_id)` + `.in('list_filter.list_id', ids)`): FAIL on rpc, `42703 column pgrst_call.list_id does not exist`. Same request on `from('properties')` works. |
| e | PASS | `.gt('id', cursor).order('id').limit(3)` on the rpc builder: 2 pages, 4 unique ids, ordered. |
| f | PASS | Function with `pg_sleep(15)` under the role's default statement_timeout → `error.code === '57014'`, "canceling statement due to statement timeout", HTTP 500. |
| g | PASS | Missing function → `PGRST202`, HTTP 404, "Could not find the function public.<name>(q) in the schema cache". |

## Surprises (design impact)

1. **Filters on an embedded resource are broken on the rpc builder.** Any `.in/.eq/.or(referencedTable)` on an embed alias (`list_filter.list_id`, `cm.direction`) is resolved against `pgrst_call` instead of the embedded table. Variants tried, all 42703: aliased and unaliased, `.in`, `.eq`, `.or` with `referencedTable`, with and without `.order`. A bare `!inner` embed with no filter works (b, and list `!inner` with no filter returned A and C). Consequence: the translator's list and tag blocks (and any engagement fragment that filters on an embed) cannot run on the Search rpc builder as written. Plan §6 (computed-field predicates instead of embedded filters, proven in c on the rpc builder) is the required route, not an optimisation. PR A must convert list/tag to computed fields (or the Search path must not use embedded filters).
2. **`.order(col)` requires `col` in the select list on the rpc builder** (`select('id').order('address')` → 42703 `properties.address does not exist`; `from()` allows it). Always select the order column.
3. HEAD+count had no GET/POST difference issue; count returned numeric as expected.
