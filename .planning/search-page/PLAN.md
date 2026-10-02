# Search page — technical plan (DRAFT, not approved)

Base: origin/main `a78e474f`. Branch `claude/search-page`. Status: planning only — no code written.
Revision 6: Astra r3 (rev 5) NO (1: inlining impossible on PG17 for subquery bodies) — C1/C2 + Fable R17/R18 addressed. Prior: Revision 5: Fable r1 NO → r2 YES → r3 (rev 4) YES with R13–R16. Astra r1 NO (4) → r2 (rev 4) NO (2: engagement overlap, campaign recipient binding) — B1–B5 + R13–R16 addressed below. D3 decided by Jarrad.

## Goal (owner intent, Jarrad 2026-10-02)
The "Prospects" page (`/properties`) becomes **Search**:
1. Shows leads AND prospects by default (not just `status=prospect OR is_dnc_locked`).
2. Its search box matches everything the top-bar global search matches (address, city, state, zip, market, APN, MLS #; homeowner/agent name, company, email, phones by digits; SMS message text) — not just street address.
3. Search ANDs with every existing filter block, including outreach outcome (`outreach_dispo`: wrong_number, not_interested, nurture, …).
4. Stress-tested before release.

Out of scope (separate change): a property holding more than one outcome; wrong-number stored per phone instead of per property.

## Open owner decisions (recommended default ⭐ — reviewers assume the ⭐)
- **D1 Bulk texting / dialer from Search** — ⭐ act on prospects only; leads in a selection are skipped and the UI says "N leads skipped". (Leads are mid-conversation; a mass text to them risks double-texting, frequency complaints, and 10DLC content mismatch.)
- **D2 Dead/closed by default** — ⭐ shown (search must always find a person).
- **D3 Restricted Acquisitions members** (PR #624, app-layer restriction in `src/lib/auth/surface-access.ts`) — today they're blocked from the Leads board and Messages, but the top-bar global search already lets them find ANY property/owner (lead or prospect) and open its detail page; only message-thread hits/snippets are withheld (`src/app/api/search/route.ts:36-53`). ⭐ Search mirrors that exact rule: everyone sees all statuses; for restricted members the server calls the RPC with message matching OFF and the page omits message previews. **DECIDED by Jarrad 2026-10-02: same rule as the top bar.**
- **D4 Training rows** (`properties.is_training`) — ⭐ excluded by default.
- **D5 Other bulk actions (tag, add to list, assign, delete)** — today they silently drop non-prospects via `resolveProspectEligibility`. ⭐ Keep them prospects-only for this change but make the skip visible ("N leads skipped"); allowing them on leads is a follow-up.
- **D6 URL** — ⭐ keep `/properties` as the real route, add `/search` → `/properties` temporary redirect (no route-file churn; saved links keep working).

## Provider-informed constraints
**Supabase / PostgREST / Postgres**
- `.in("id", ids)` puts ids in the URL: 414s around 8 KB (~200–400 uuids) on the gateway (postgrest-js #393/#423); repo's `bulk-lookup.test.ts` documents a 32 KiB limit. Pre-fetching search ids and `.in()`-ing them would break on common names. **Rejected.**
- PostgREST lets a function that `returns setof <table>` be filtered, embedded, ordered, ranged and counted exactly like a table (docs.postgrest.org › functions). supabase-js `rpc()` returns a `PostgrestFilterBuilder`, so `applyFilters` (duck-typed builder) and `filterSelectFragment` embeds (`property_lists!inner`, `messages!inner`) work on it. **Chosen.**
- Chained filters are applied *after* the function runs (no inlining for SECURITY DEFINER / `SET search_path` functions). So the function's own output must be bounded by the text match, and must **not** cap rows before filters (a pre-filter cap would silently drop true matches).
- pg_trgm GIN serves `ILIKE '%x%'` only with ≥3-char patterns; shorter degrades to full scan (postgresql.org pgtrgm). FTS prefix via `to_tsquery('simple','x:*')` — raw input must be sanitized (existing `search_prefix_tsquery` does this).
- Cross-table OR defeats indexes; use UNION of per-source id sets then semi-join to `properties`.
- Statement timeout: `authenticated` 8 s → error 57014 (supabase.com/docs/guides/database/postgres/timeouts). Must map to "Search too broad — try a more specific name, phone or address".
- `count: 'exact'` re-evaluates the function per count. The page runs 1 main + 4 CASS counts → 5 function evaluations per load.
- RLS on properties/contacts/messages is org-level only (`054_memberships_and_rls_rewrite.sql`). `search_global` is SECURITY DEFINER because RLS evaluation blocked index use (migration D6 comment); it re-implements the membership gate (`visible_orgs`: active, not expired, not deletion-prepared) and revokes from public/anon.
- Migrations: function in its own file with `lock_timeout 5s`; any new index built separately and checked with `pg_index.indisvalid`; end with `notify pgrst, 'reload schema'`. Applied through the established Sandra migration workflow only.

**Next.js 16.2.x (installed docs)**
- `redirects()` in `next.config.ts` runs before the filesystem and forwards the query string; use `permanent: false` (308s are cached by browsers forever).
- `searchParams` is a Promise in server pages (already handled). Server Action body limit is 1 MB (`next.config.ts`) — never ship id lists from client to server for this feature; re-resolve from filters server-side.
- Existing toolbar search debounces 250 ms and writes `?search=` — keep.

**Vercel** — function default 300 s, body 4.5 MB; not binding. No id lists in URLs.

**Messaging providers / dialer**
- Bulk SMS: `bulk-sms-modal` → `bulkQueueSms` (`actions.ts:331`) or `bulk-sms` workflow (>500) → `queueSmsBatch` (`bulk-queue.ts:129`) → provider from `MESSAGING_PROVIDER` (dialpad/sendillo/twilio/mock) on cron release. **No status check anywhere on this path today** — it's only safe because the page lists prospects. No provider API changes; guard is ours.
- Dialer batches: already prospects-only through `fetchEligibleDialerPropertyRows` → resolver (purpose `dialer`); consumed by Jitter. Only change: surface the skipped-lead count.

## Design

### 0. Spike first (R2 — BLOCKING precondition)
Spike output is pasted into the PR body before any UI commit.
Before any UI work, a throwaway integration test on the hosted test project (supabase-js pinned 2.104.0 — count/head go on `rpc()`'s third argument, A5) proving: (a) `rpc('search_properties', {q}, {count:'exact', head:true}).select('id')` returns a numeric count; (b) a separate row request `rpc('search_properties', {q}).select('id, homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1), contacted_messages:messages!inner(direction)').order('address').range(0,24)` returns real embedded rows; (c) one computed-field filter (§6) works on both `from('properties')` and the rpc builder; (d) `applyFilters` on the rpc builder for one embedded block. If `!inner`/FK embedding or HEAD+count fails on RPC results, stop and re-plan (view-based alternative) — Opus 5.5 reviews the changed design before continuing.

### 1. Database: `public.search_properties(q text)` returns `setof public.properties`
- New migration (timestamp after newest). SECURITY DEFINER, `set search_path = public, pg_temp`, owner postgres, `revoke all from public, anon`, grant `authenticated, service_role` — copy `search_global`'s block and its self-check.
- Signature `search_properties(q text, include_messages boolean default true)` — single signature, never overloaded (overloads break PostgREST rpc resolution, R12). Returns zero rows when `auth.uid()` is null (R5).
- Matching is substring/phone/FTS only — **no trigram-similarity (fuzzy) branch**, unlike `search_global` (R3). Deliberate: precise, oracle-checkable results; fuzzy can be a follow-up.
- Body: same `visible_orgs` gate as `search_global`; `bounds` (trim, ≤100 chars, ≥3 chars else returns nothing — the app never calls it under 3 chars); normalized `qd` (digits), escaped `q_like`, `tsq`.
- Candidate id set = UNION of:
  - properties: `search_text ILIKE %q%`
  - contacts matched by `search_text ILIKE %q%` or (`length(qd)>=3` and `phone_digits ILIKE %qd%`) → every non-deleted property where contact is `homeowner_contact_id` **or** `agent_contact_id` (not "most recent one" like search_global).
  - messages: `channel='sms'`, `fts @@ tsq` → their property (mirror search_global's message→property/conversation join exactly).
  - each branch restricted to `visible_orgs`.
- Returns `properties` rows for candidate ids with `deleted_at is null`. **No row cap.** No status filter (the app layer owns scope).
- No other filtering inside the function — all existing blocks keep running through `applyFilters` on the rpc builder.

### 2. One query context, built server-side: `src/lib/prospects/search-scope.ts`
`type QueryOrigin = 'legacy' | 'search_page'`. Every query/selection/action path takes an origin; **default `'legacy'`**.

- **`'legacy'` is byte-for-byte today's behavior** (A6): status `prospect OR is_dnc_locked` unless a pipeline_status block; unescaped `ilike('address', %search%)`; no training predicate; uncapped keyset select-all. Campaign audience snapshots (`campaigns/actions.ts:320,1345,1999`), `dnc-safe-actions.ts:237` legacy callers, bulk tag from Leads (`leads/actions.ts:1363`) stay on it. Regression fixtures include wildcard searches, training rows and audiences larger than the Search cap.
- **`'search_page'`**: scope all statuses; `is_training = false` (D4); search ≥3 chars → `rpc('search_properties', {q, include_messages})`, 1–2 chars → escaped address ILIKE (`%`, `_`, `\`), empty → `from('properties')`; select-all capped (§3).
- `include_messages` is derived server-side, **fail-closed** (A1): `getCallerMembershipsOrThrow()` + `canAccessMessagesAndLeadsBoard()` — the same pair `api/search/route.ts:16-20` uses. Lookup failure → error page, never "unrestricted". The same flag gates the message-preview fetch and its serialization (`page.tsx:285-324`). Not a DB boundary: direct RPC calls with `include_messages=true` return message matches, as `search_global` does today (R10).
- Origin is client-supplied but can only choose matching semantics, never widen access (RLS + server-derived `include_messages` unchanged). Campaign creation/launch always forces `'legacy'` server-side.
- **Every filter-based action launched from Search carries `origin:'search_page'` + search + blocks** and re-resolves server-side (A3): page main query + count, `_actions/count.ts` (also fixes its drift — it ignores `search`/`imported`; `use-debounced-filters.ts:35`), select-all (`prospects-table.tsx:351-367,818-847`), bulk tag from filters (`bulk-tag-modal.tsx:95-100` → `dnc-safe-actions.ts:237`), dialer from filters (`batch-create-modal.tsx:153-157` → `actions.ts:848`), bulk-SMS audience. Then action eligibility (prospect-only) applies on top.
- `search_properties` is never called via `createAdminClient` (would see `auth.uid()` null → empty) — grep test (R5).
- Then `applyFilters(builder, blockStack, supabase)` and `imported=today`.
- Unit tests that pin the literal `.or(...)` (`page.dnc-org-contract.test.ts`, `actions.select-all.test.ts:211`) retarget to the module's `'legacy'` branch.

### 3. Counts, selection sets, timeouts
- Main count `count:'exact'` on the same builder. CASS breakdown hidden while a global search is active (R4). Budget ≤2 `search_properties` evaluations per page load (`pg_stat_user_functions` delta).
- Two distinct sets (A7): **matched** (what the page lists; count shown) and **action-eligible** (matched ∩ prospect ∩ not DNC). Select-all returns both counts and the exclusions broken out (leads, DNC, missing/deleted). Page parity is asserted against matched; action parity against eligible.
- Search-origin select-all is capped by a new constant (each 1k keyset page = one function evaluation; value set from the §stress volume run). Over the cap → error, **no partial actionable selection**. Legacy select-all stays uncapped.
- PostgREST `code === '57014'` → "Search too broad — try a more specific name, phone or address" (A8). `PGRST202` (function missing) → fall back to address search with a small notice, mirroring `api/search/route.ts:33` (A9).

### 4. Bulk guards (D1, D5)
- **Saved-campaign exemption is bound to the frozen audience** (B2/R16): for a saved campaign the server derives the recipient ids from the persisted frozen audience and rejects any supplied id outside it (today `validateProvidedCampaignForBulkSms`, `actions.ts:193,253`, checks campaign state + org only). The deferred workflow derives provenance from the campaign record, not from job input (`bulk-sms.ts:202` copies `campaignSource` from input today), keeping org validation.
- Prospect-only guard applies **only to the ad-hoc Search path** (A2). Saved campaigns call `bulkQueueSms` with frozen recipients (`campaigns/actions.ts:1991-1997,2043-2046`); provenance is validated server-side from the stored campaign row (`properties/actions.ts:370-407`), and campaign sends are untouched — a frozen recipient later promoted to a lead is still sent exactly as today.
- Ad-hoc path: guard applied before the freeze, and the freeze receives the **filtered** ids (today it passes the original `propertyIds`, `actions.ts:400`). Same guard in `assessBulkSmsAudience` (`:91`) and `countAlreadyContacted` (`:1019`) so modal counts match. Workflow (>500, `src/workflows/bulk-sms.ts:406`, `ad-hoc-bulk-sms.ts:62-85`) re-checks per chunk for ad-hoc only. Not in `queueSmsBatch` (shared with campaigns/sequences).
- Dialer, tag, list, assign, delete wrappers: already prospect-only via `resolveProspectEligibility`; now return and display `skippedLeads`.

### 5. UI / copy
- Sidebar `dashboard-sidebar.tsx:59` → "Search" (lucide `Search` icon). Metadata `page.tsx:110`, header 466–473, breadcrumb/title `prospects-table.tsx:543-544`, input aria-label "Search leads and prospects by name, phone, email, address or message", empty state 950–952 ("No results — searches need 3+ characters to match names, phones and messages" when 1–2 chars).
- Show a Status column (prospect vs lead stage) so mixed results are legible.
- `"Prospects"` literal back-link labels (`surface-access.ts:5-6,68`, `lead-media-hero.tsx`, `delete-lead-button.tsx`, `leads/[id]/page.tsx`) → "Search".
- Other copy pointing at `/properties` (import steps, kpi-cards, promote dialog, campaign form) → "Search".
- `/search` redirect in `next.config.ts` (D6).
- Statement-timeout (57014) → inline "Search too broad — try a more specific name, phone or address" (same text as §3).
- Pipeline Status block prefill `["prospect"]` (`pipeline-status-block.tsx:26-30`) stays.

### 6. Filter translator hardening (A4) — ships first, own PR
Today the pre-fetch blocks read unbounded message/task sets (truncated at PostgREST's 1000-row cap, `filter-to-supabase.ts:794-797,951-956`) and push id lists into URLs (`:924-935,966-976`). Showing leads — the rows with long message histories — makes this worse, so it is fixed here, not deferred.
- Each pre-fetch block (engagement buckets, has_unread_inbound, has_open_tasks, tag, list_count, non-embedded list) becomes either an embedded `!inner` filter or a PostgREST **computed field** (stable SQL function over a `properties` row, e.g. `has_unread_inbound(properties) returns boolean`, `engagement_bucket(properties) returns text`) filtered with `.eq/.in` on the value — works identically on `from('properties')` and the rpc builder, no id lists, no unbounded reads. Negative ("not") variants use the boolean/value, not anti-id-lists.
- **Engagement** (B1/R14/C2): `engagement_state(properties) returns text` — never null — for the three mutually exclusive states; `opted_out` stays a column predicate on `outreach_dispo` (nullable, `045_outreach_dispo.sql:24`). Legacy quirks are pinned, not corrected (any correction is a separate owner decision).

  Definitions (today's code, `filter-to-supabase.ts:707-936`; messages = all rows with `property_id`, any channel): R = has an inbound message; O = has an outbound message; **replied** = R; **attempted** = O ∧ ¬R; **never_contacted** = ¬R ∧ ¬O; X (**opted_out**) = `outreach_dispo IN ('opted_out','dnc')`; ¬X = `outreach_dispo IS NULL OR outreach_dispo NOT IN ('opted_out','dnc')` (NULL dispo is **not** opted out — today's `not` is id-based and keeps NULLs, `:865`).

  | combinator | values V | today's result | new predicate |
  |---|---|---|---|
  | any | single v | S(v) | `engagement_state = v`, or `X` for opted_out |
  | any | multiple | ⋃ S(v) | `.or(...)` of the above per value |
  | not | any V | rows ∉ ⋃ S(v) | `engagement_state NOT IN (V∖{opted_out})` AND (¬X if opted_out ∈ V) |
  | all | contains never_contacted, or both attempted & replied | ∅ | no-match sentinel |
  | all | single v (other) | S(v) | same as `any` single |
  | all | other multiple (e.g. {replied, opted_out}) | ⋃ S(v) — **legacy quirk: union, not intersection** | same as `any` multiple |

  Empty V → no-op. The table is committed as a **data fixture** (R17) enumerating all 15 non-empty value sets × 3 combinators = 45 cases; expected ids for the small fixture are generated once from a **frozen test-only copy of today's translator** checked into PR A, not from `main` at review time.
- **Function contract** (R13/B4, corrected per C1): every computed field is `language sql stable security invoker`, single `SELECT`, no `SET` clause, schema-qualified references, unnamed composite argument (so PostgREST does not expose it as an RPC), execute granted to `authenticated` only. **These functions will NOT inline**: PostgreSQL 17's scalar inliner rejects bodies with subqueries/table references (`clauses.c` `inline_function`, `hasSubLinks`/`rtable`; repo runs PG 17, `supabase/config.toml:8`). They execute once per candidate row, with each internal lookup using its index (`idx_messages_property`, `idx_messages_unread_inbound`, tasks/tags indexes). Acceptance is therefore the complete-request budget (stress #9), measured with nested-statement instrumentation (`auto_explain.log_nested_statements = on`, `pg_stat_statements.track = all`) on the local stack — outer `EXPLAIN` alone does not show the inner plans.
- **Mandatory set-based fallback** if any computed-field filter misses budget: denormalized columns on `properties` (`has_inbound`, `has_outbound`, `has_unread_inbound`, `open_task_count`) maintained by triggers + one backfill migration, filtered as plain indexed columns. Choosing the fallback requires an Opus 5.5 review (changed design only) before build continues.
- If a definer body ever becomes necessary → separate authorization design + Opus 5.5 review.
- Semantics preserved **per spec, with the >1000-row truncation fixed** (R15): the fixture with >1000 messages is expected to disagree with the old translator. Small-fixture behavior pinned against today's translator separately.
- Out of scope, follow-up issues: state picker reads all `state` rows (`page.tsx:220`); message-preview query unbounded (`page.tsx:285`); `leads/actions.ts:1363` drops `is_dnc_locked`.

### 7. Delivery
**Spike result (2026-10-02, SPIKE-RESULTS.md):** (a)(b)(c)(e)(f)(g) pass; (d) embedded-resource filters fail on rpc builders (`42703 pgrst_call.<col>`). Consequence: PR A converts EVERY embedded-filter block (list, tag, list_count/stack, engagement fast paths) to computed-field/column predicates, and tests all block kinds on both builders. `.order(col)` on rpc needs `col` selected.
**Migration ordering:** prod migrations auto-run after merge to main (`db-migrate-test.yml` → `db-migrate-prod.yml`), so each PR's additive migration ships first as its own migration-only PR, verified in prod, before the code PR merges.
- **PR A — filter translator hardening (§6)**, `Depends on: none`. Migration (computed fields) + translator + tests. Behavior-preserving on today's Prospects page.
- **PR B — Search page (§0–5)**, `Depends on: PR A`, created with `--base <PR A branch>`.
- Activation order (A9): each PR's additive migration is applied and verified through the established Sandra migration workflow (function exists, `notify pgrst, 'reload schema'`, a canary RPC call succeeds) **before** the app code that calls it is deployed. App rollback = revert the app; additive functions stay installed.

## Stress-test plan (revised per Fable)
Environments: merge-gate tests on hosted `sandra-crm-test` via `npm run test:integration` (suite advisory lock; `tests/integration/fixtures/multi-user.ts`). Volume on local loopback Postgres (`vitest.local-integration.config.ts`) only — never the shared CI project.

**Must-have (merge gate)**
1. **Matching matrix.** Same name across prospect/new_lead/interested/dead/closed all returned; soft-deleted and training never; phones in every format `(555) 123-4567`, `555.123.4567`, `+1 555 123 4567`, last-4, phone_2/phone_3, <3 digits no phone match; names case/partial/full "jane doe"/entity "Doe Family Trust LLC"/O'Brien/Smith-Jones/accents/extra spaces; agent-contact match; email partial; address/city/zip/APN/MLS/unit "#2B"; SMS text matched, non-SMS not; `include_messages=false` suppresses message matches. Hostile input: `%`, `_`, `\`, quotes, commas, parens, `or(`, `:*`, `&|!`, 500 chars, emoji, whitespace — no errors, no wildcard blow-ups (incl. 1–2 char fallback, R6). Null `auth.uid()` / service-role call returns empty (R5).
2. **Independent reference oracle.** A naive TypeScript matcher over the fixture rows, written by a different agent than the SQL author; disagreements are investigated, never "aligned" by editing the oracle to match. 30 queries in CI, 200 locally.
3. **Filter correctness against independent expectations** (A4). Expected results computed in TypeScript from fixture data, never by re-running the translator. Fixtures include: a property with >1,000 messages; >1,000 matching properties so the match falls beyond the first response page; enough distinct ids to exceed the gateway URL limit (>400) for tag/list/engagement/unread/open-task blocks; positive and negative variants; executed through real PostgREST (authenticated client), with and without search. Includes NULL-`outreach_dispo` fixtures in each of the three message states, tested with singleton and mixed `not` selections through both table and rpc builders (C2); the 45-case engagement fixture; overlapping-bucket fixtures (opted-out AND replied/attempted/never) and multi-value `all` for engagement, tags and lists; every engagement any/all/not combination from the translation table; computed fields exercised against cross-org child rows and inaccessible properties via both `from('properties')` and the rpc builder. Covers engagement, list, tag, has_unread_inbound, has_open_tasks, list_count, `outreach_dispo` (wrong_number, not_interested, nurture), `pipeline_status`; plain column blocks sampled.
4. **Pagination/count parity** across every sort column incl. nullable ones, with one property matching via all three branches (no dupes, count == rows walked).
5. **Security.** Restricted member: direct RPC with `include_messages=true` returns message matches (documented app-layer parity); server derives `include_messages` from memberships, a client-supplied flag is ignored (R10). Org B invisible to org A via every branch; inactive/expired/deletion-prepared membership sees nothing; anon cannot execute; restricted Acquisitions member: no message matches/previews, and documented assertion that direct RPC returns all statuses (same as today's RLS).
6. **Mutation list** — each must fail ≥1 test: drop org gate, drop agent-contact join, drop `deleted_at`, drop LIKE escape, add `limit 100` pre-filter, drop `channel='sms'`, swap `auth.uid()` for null.
7. **Regressions.** Matched-set parity: select-all matched ids == page rows walked for the same URL state; eligible-set parity: action targets (tag, dialer, bulk SMS) == eligible subset of matched (R9/A3/A7); over-cap select-all returns an error with no actionable ids. Membership lookup failure → no message matches/previews, error surfaced (A1). Saved-campaign send with a recipient promoted to lead after freeze: sent exactly as today, sync and workflow sizes (A2). Forged origin/source, an ad-hoc campaign id passed as saved, and a genuine saved campaign with an injected lead id → rejected (B2/R16). Ad-hoc: a recipient promoted after freezing but before a deferred chunk is skipped at that chunk. Ad-hoc freeze stores filtered ids. Legacy callers: wildcard search, training rows, >cap audiences identical to today (A6). `PGRST202` fallback (A9). Campaign snapshot with `search` resolves identical ids before/after (R1); bulk SMS mixed selection (prospects + leads + DNC-locked) queues prospects only with correct skipped count, incl. >500 workflow path; dialer same; evaluation-count budget ≤2 (R4); 57014 mapping (R8); admin-client grep (R5).
8. **E2E, max 3 Playwright specs:** type → debounce → `?search=` → rows + count; search + outreach_dispo chip + pagination; `/search` redirect keeps query. Update existing specs/tests asserting "Prospects" or prospect-only default (`qualify-flow.spec.ts:96-98`, `properties-filter-production-data.spec.ts:34`, `leads-csv-schema-backed-acceptance.spec.ts:128`, `sequences-flows.spec.ts:388`, `prod-canary/auth-shell.spec.ts`, `prospects-table.test.tsx:227,624`, `surface-access.test.ts:105`, `page.dnc-org-contract.test.ts`, `actions.select-all.test.ts:211`).

**Pre-release, local (not CI)**
9. **Volume (A8/B3).** Runs against a disposable local Supabase stack (`supabase start`: Postgres + PostgREST on loopback), with JWTs minted for seeded org users, PostgREST `db-max-rows` and `authenticated` statement_timeout (8 s) matching production, registered as its own opt-in vitest config (not added to the existing `vitest.local-integration.config.ts` allowlist, which is Postgres-only). **PR A gate:** each computed-field filter on the unsearched 50k page — positive, negative, combined, with exact count — p95 ≤ 2× the baseline and within the buffer budget, where the baseline is today's translator run from the frozen copy **on the same seeded stack in the same run** (R18); nested lookups inspected via `auto_explain.log_nested_statements` / `pg_stat_statements` (C1). Over budget → a set-based alternative and Opus 5.5 review, not just a recorded number. Seed ~50k properties / ~60k contacts / ~250k SMS with realistic skew: common surnames (top surname on ~2% of contacts), shared area codes, and message-heavy leads (20 leads × 5k messages). `ANALYZE`. Measured as the **complete authenticated PostgREST request** (rows + exact count + embeds + outer filters + sort), not branch-by-branch. Representative queries that MUST succeed: common surname, full phone, last-4 phone, house number + street, a word present in ~5% of threads, each alone and combined with a selective filter (outreach_dispo=wrong_number) and a broad one (pipeline_status = all lead stages). Budgets on the reference machine: page request p95 ≤ 1.5 s and ≤ 3× the same filters without search; ≤ 50k shared buffers per request; Search select-all up to the cap ≤ 10 s. `EXPLAIN (ANALYZE, BUFFERS)` must show trigram/FTS index use in each branch. Only deliberately pathological inputs (e.g. "the", "816" alone) may hit the friendly timeout — never a 500. Computed-field filters (§6) measured on the unfiltered 50k table too.
10. **Human-feel** on the preview deploy in the in-app browser: typing latency, loading state, mixed-status legibility.

Dropped as wasteful: full 23-block matrix in CI; absolute ms budgets on a laptop; "search_global ⊆ search_properties" oracle (false by design — fuzzy branch, R3).

## Build-time rulings (recorded)
- Membership lookup failure on the page: fail-closed partial render (include_messages=false + alert), not an error page — Opus SHOULD 3, accepted by coordinator.
- Structured-phone rule: raw digits ≥3 and 10*raw_digits ≥ 7*len(q without whitespace); leading-1 stripped for matching. Whitespace runs (any kind) collapse to one space before the 100-char cut.
- PR A uses trigger-maintained cache columns (computed fields were 9–463× over budget); backfill in 110050 commits per batch under pinned CLI 2.109.1 (verified).

- Search volume ratio budget (≤3× no-search) exempt when the no-search baseline p95 < 50 ms (noise floor); the 1.5 s absolute budget still applies (common surname + wrong_number: 75 ms vs 15 ms). SEARCH_SELECT_ALL_CAP = 20,000 (20k ids walked in 2.46 s locally).

## Rollout
**Review policy (Jarrad 2026-10-02):** intermediate reviews = Opus 5.5 only, scoped to changed code + unresolved findings, reusing the plan-stage findings (R1–R20, A1–A9, B1–B5, C1–C2) as the checklist. Fable and Astra are used **only** for the final, tested release-candidate review immediately before each release — never for intermediate rounds. Scope, single writer per worktree, spending limits and safety gates unchanged.

Per PR (A then B): Sonnet builder in this worktree → Opus intermediate review → full stress suite → apply additive migration via established workflow + verify (§7) → preview deploy + human-feel check → Fable + Astra release-candidate review (`APPROVE_MERGE: YES` at head) → merge → prod smoke (search a known canary name/phone; restricted-member check; filter counts unchanged on legacy views).
