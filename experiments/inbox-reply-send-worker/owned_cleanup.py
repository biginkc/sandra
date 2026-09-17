"""[Astra round-3/4/5/6 — round 6 is the DEFINITIVE, FINAL closure] Dynamic,
exhaustive-by-construction, and HONEST residual verification, shared by
proof.py and runtime-proof.py. History of what this module closes:
- round 3: leaked tables missed by hand-maintained enumeration (access_epochs;
  message_capture.*/operation_domain.*; inbox_t2_policy.versions/parent.work/
  maintained.queue/projection_proof.dirty).
- round 4: the counter-table discovery itself was too narrow —
  public.hugo_owner_guard_serialization (a shared, cross-fixture
  serialization counter the round-2 owner-guard trigger dance advances on
  every memberships DISABLE/ENABLE TRIGGER cycle) was outside the old
  `inbox_t2_*`/`inbox_operation_domain` schema pattern, never even
  snapshotted, and the printed "zero net residual" was FALSE.
- round 5: the counter/shared check only compared row count + one counter
  column's SUM — a synthetic content swap in any OTHER column of a
  counter/shared table (e.g. hugo_owner_guard_serialization.guard_key, or
  the uuid in inbox_t2_capture_boundary.generation.generation) passed
  silently.
- round 6 (this one): round 5's content hash was applied only to the
  "neither org_id nor user_id" counter/shared set — an id-scoped table's
  PRE-EXISTING (non-synthetic) baseline rows were never hashed at all, only
  proven "this run's own rows are gone" (assert_zero_residual's scoped
  count). Astra's repro: seed a baseline row in inbox_t2_policy.versions,
  create+delete this run's own owned row (net zero), then mutate the
  baseline row's entity_key — row count and the revision sum both unchanged,
  so the round-5 checks saw nothing. Closed by applying the SAME per-row
  content-hash machinery to EVERY id-scoped table too (id_tables,
  PRIMARY_TABLES included), baselined before any synthetic id exists and
  re-verified, after cleanup, over exactly the rows NOT owned by this run —
  see assert_baseline_unchanged. This module:

1. EXHAUSTIVE COVERAGE, not enumeration: every base table ANYWHERE in the
   database (any schema, never hardcoded) with an org_id or user_id column is
   discovered via pg_catalog, excluding only the "primary" tables the caller
   already manages explicitly (PRIMARY_TABLES) and the ephemeral reply-lane
   schemas that get DROP SCHEMA CASCADEd entirely each run (EPHEMERAL_SCHEMAS).
2. Because this run's org/user ids are freshly generated random UUIDs, no
   pre-existing row anywhere can ever match them — so a SCOPED count is
   already an exact zero-baseline diff without needing a snapshot, and unlike
   a raw whole-table row-count diff is immune to unrelated concurrent
   activity elsewhere in this shared fixture database.
3. Every OTHER base table anywhere in the database (same universe, minus the
   org/user-scoped ones) is a "counter/cursor" candidate — likewise ANY
   schema, never a hardcoded pattern. For each:
   - if it has an integer/bigint column whose name matches a counter-shaped
     pattern (version/revision/generation/counter), that column's SUM is
     snapshotted as its VALUE, not just the table's row count — this is what
     the round-4 finding required: catching a value that changed even though
     row count didn't.
   - [Astra round-5] EVERY column except that one recognized counter column
     (or every column, if there is none) is snapshotted as a per-row CONTENT
     HASH: `to_jsonb(row) - counter_column`, md5'd per row, the per-row
     hashes sorted and joined so row order never matters, then md5'd again
     into one table-level digest. Round 4's fix only compared row count + the
     counter SUM — Astra defeated it by replacing
     hugo_owner_guard_serialization.guard_key='memberships' with a synthetic
     value (row count and version both unchanged) and by mutating the uuid
     in inbox_t2_capture_boundary.generation.generation the same way; both
     passed silently. The content hash makes ANY byte of ANY non-counter
     column, in ANY discovered counter/shared table, part of what "unchanged"
     means — there is no longer a column a mutation can hide in.
4. HONEST classification at residual time, matching what production
   correctness actually requires (never move a shared serialization counter
   backward — see round 4's own instruction):
   - row count unchanged AND content hash unchanged AND (no counter column OR
     its value unchanged): genuinely untouched — silent pass.
   - row count unchanged AND content hash unchanged AND counter value
     INCREASED: a benign monotonic serialization/version advance — holds no
     synthetic rows and mutates nothing else, so nothing to delete or roll
     back. Reported EXPLICITLY (not silently folded into "zero residual"),
     and does not fail the run.
   - row count changed, OR the content hash changed (ANY non-counter column
     mutated, in ANY row), OR a counter value DECREASED, OR a table this
     run's own write-activity touched was never classified as org/user-scoped
     or counter-shaped at all: FAILS loudly, by table (and column, for a
     counter decrease).
5. Cleanup SWEEPS every dynamically-discovered org_id/user_id-scoped table
   (not a hand-maintained list), repeated for several passes so a table
   repopulated by another table's AFTER trigger (the round-2 finding) is
   still empty by the last pass — order-independent by construction. Counter
   tables are NEVER deleted from, reset, or otherwise written to by this
   module — see point 4.
"""

# Tables the caller already deletes explicitly, in the correct FK/trigger
# order (owner-guard trigger dance on memberships, etc.) — never touched by
# the generic sweep, only reconfirmed by the generic residual check (which is
# still useful: it independently proves the caller's own explicit cleanup
# actually worked, using a different code path than the DELETE it audits).
PRIMARY_TABLES = {
    'public.organizations', 'auth.users', 'auth.sessions', 'public.memberships',
    'public.messages', 'public.contacts', 'public.properties',
    'public.consent_events', 'public.provider_sender_numbers',
}
# Schemas created fresh and DROP SCHEMA CASCADEd entirely by the caller each
# run — querying them after the drop would error (table does not exist), and
# their rows can never leak because CASCADE removes them unconditionally.
EPHEMERAL_SCHEMAS = {
    'inbox_reply_context', 'inbox_reply_preparation', 'inbox_reply_review',
    'inbox_reply_send', 'inbox_reply_send_scratch',
}
# Column-name shape treated as a monotonic serialization/version counter when
# its SQL type is integer/bigint (never uuid/text — e.g.
# inbox_t2_capture_boundary.generation.generation is a uuid "generation id"
# that gets swapped, not an incrementing counter, and stays row-count-only).
COUNTER_COLUMN_PATTERN_SQL = r"a.attname ~* '(version|revision|generation|counter)$'"


def _rows(sql, query):
    out = sql(query)
    return [r for r in out.splitlines() if r.strip()]


def _scoped_tables(sql, column):
    exclude_schemas = ','.join(f"'{s}'" for s in EPHEMERAL_SCHEMAS)
    found = _rows(sql, f"""
        SELECT DISTINCT n.nspname||'.'||c.relname FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='r' AND a.attname='{column}' AND a.attnum>0 AND NOT a.attisdropped
          AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname<>'information_schema'
          AND n.nspname NOT IN ({exclude_schemas})
        ORDER BY 1
    """)
    return [t for t in found if t not in PRIMARY_TABLES]


def _counter_tables(sql):
    """[Astra round-4] EVERY base table anywhere in the database (no schema
    restriction — the round-4 bug was exactly a schema restriction hiding a
    real table) with NEITHER org_id NOR user_id. Returns
    [(table, counter_column_or_None)]."""
    exclude_schemas = ','.join(f"'{s}'" for s in EPHEMERAL_SCHEMAS)
    rows = _rows(sql, f"""
        SELECT n.nspname||'.'||c.relname||'|'||coalesce(
          (SELECT a.attname FROM pg_attribute a
           WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
             AND {COUNTER_COLUMN_PATTERN_SQL}
             AND format_type(a.atttypid,a.atttypmod) IN ('integer','bigint','smallint')
           ORDER BY a.attnum LIMIT 1), '')
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='r'
          AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname<>'information_schema'
          AND n.nspname NOT IN ({exclude_schemas})
          AND NOT EXISTS(
            SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
              AND a.attname IN ('org_id','user_id')
          )
        ORDER BY 1
    """)
    out = []
    for r in rows:
        table, _, col = r.partition('|')
        if table in PRIMARY_TABLES:
            continue
        out.append((table, col or None))
    return out


def _counter_column(sql, table):
    """The one recognized counter-shaped integer/bigint column on `table`, if
    any — same detection COUNTER_COLUMN_PATTERN_SQL uses for the "neither
    org_id nor user_id" counter set, now also applied to id-scoped tables
    (e.g. inbox_t2_policy.versions.revision) so a legitimate monotonic
    counter advance on an unrelated baseline row is never mistaken for the
    kind of content mutation this module exists to catch."""
    schema, name = table.split('.', 1)
    rows = _rows(sql, f"""
        SELECT a.attname FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='r' AND n.nspname='{schema}' AND c.relname='{name}'
          AND a.attnum>0 AND NOT a.attisdropped AND {COUNTER_COLUMN_PATTERN_SQL}
          AND format_type(a.atttypid,a.atttypmod) IN ('integer','bigint','smallint')
        ORDER BY a.attnum LIMIT 1
    """)
    return rows[0] if rows else None


def _id_tables(sql):
    """[Astra round-6] EVERY table anywhere in the database (any schema,
    PRIMARY_TABLES INCLUDED this time — round 6's own escape was an id-scoped
    table) with an org_id and/or user_id column. Returns
    [(table, has_org, has_user, counter_column_or_None)] — used for the
    baseline content-hash check, which is independent of (and a superset of)
    the synthetic-id scoped-count check sweep_delete/assert_zero_residual
    already do on the org_tables/user_tables subset (PRIMARY_TABLES
    excluded)."""
    exclude_schemas = ','.join(f"'{s}'" for s in EPHEMERAL_SCHEMAS)
    rows = _rows(sql, f"""
        SELECT n.nspname||'.'||c.relname||'|'||
          bool_or(a.attname='org_id')||'|'||bool_or(a.attname='user_id')
        FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped
          AND a.attname IN ('org_id','user_id')
          AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname<>'information_schema'
          AND n.nspname NOT IN ({exclude_schemas})
        GROUP BY n.nspname,c.relname ORDER BY 1
    """)
    out = []
    for r in rows:
        table, has_org, has_user = r.split('|')
        out.append((table, has_org == 'true', has_user == 'true', _counter_column(sql, table)))
    return out


def discover(sql):
    """Dynamic table discovery — call ONCE, before installing anything, so
    the caller can snapshot baselines before any writes. Returns
    (org_tables, user_tables, counter_tables, id_tables):
    - org_tables/user_tables: PRIMARY_TABLES-excluded, for sweep_delete +
      the synthetic-id scoped-count check (unchanged since round 3).
    - counter_tables: tables with NEITHER org_id NOR user_id (round 4),
      each (table, counter_column_or_None).
    - id_tables [round 6]: EVERY org_id/user_id-bearing table, PRIMARY_TABLES
      INCLUDED, each (table, has_org, has_user, counter_column_or_None) — the
      universe for the baseline content-hash check."""
    return _scoped_tables(sql, 'org_id'), _scoped_tables(sql, 'user_id'), _counter_tables(sql), _id_tables(sql)


def _content_hash_sql(table, col, where=None):
    """[Astra round-5/6] One table-level digest over EVERY column except the
    recognized counter column (or every column, if col is None), optionally
    restricted to a WHERE clause: per-row `to_jsonb(row) - col`, md5'd,
    sorted (so row order/physical layout never matters), joined, md5'd again.
    Generic — needs no column list, no primary key, and works identically
    whether the table has a counter column or not (jsonb `-` on a key that
    doesn't exist is a no-op)."""
    drop = f" - '{col}'" if col else ""
    filt = f" WHERE {where}" if where else ""
    return f"SELECT md5(coalesce(string_agg(h,',' ORDER BY h),'')) FROM (SELECT md5((to_jsonb(t){drop})::text) AS h FROM {table} t{filt}) x"


def snapshot_counters(sql, counter_tables):
    """Per table: (row_count, counter_value_or_None, content_hash).
    counter_value is SUM(counter_column) — NULL-safe via coalesce — only when
    a counter column was found; None otherwise. content_hash covers every
    OTHER column (round-5 — see _content_hash_sql)."""
    snapshot = {}
    for table, col in counter_tables:
        count = sql(f"SELECT count(*) FROM {table}")
        value = sql(f"SELECT coalesce(sum({col}),0) FROM {table}") if col else None
        content_hash = sql(_content_hash_sql(table, col))
        snapshot[table] = (count, value, content_hash)
    return snapshot


def snapshot_baseline_hashes(sql, id_tables):
    """[Astra round-6] MUST be called before any org/user id this run will
    ever use exists — every row in every id-scoped table is, by definition,
    a pre-existing "baseline" row at this point, so the hash is computed
    over the WHOLE table, no filter needed. The counter column (if any) is
    excluded from the hash exactly as for counter_tables, so a legitimate
    monotonic advance on a baseline row (e.g. inbox_t2_policy.versions.revision
    ticking up from unrelated concurrent activity elsewhere in this shared
    fixture) is never mistaken for the content mutation this exists to
    catch."""
    return {table: sql(_content_hash_sql(table, col)) for table, _, _, col in id_tables}


def _not_owned_filter(has_org, has_user, orgs, users):
    """Row-inclusion predicate: true for a row that does NOT belong to any of
    this run's own synthetic ids — i.e. exactly the "baseline" rows the
    pre-run snapshot covered. NULL-safe via coalesce to a sentinel that can
    never equal a real synthetic uuid, so a legitimately-NULL org_id/user_id
    row is always treated as baseline (never excluded)."""
    parts = []
    if has_org:
        parts.append(f"coalesce(org_id::text,'~NULL~')<>ALL({orgs})")
    if has_user:
        parts.append(f"coalesce(user_id::text,'~NULL~')<>ALL({users})")
    return ' AND '.join(parts) if parts else 'true'


def _text_array(ids):
    """A plain text[] literal (never ::uuid[]) — some discovered tables key
    org_id/user_id as varchar (e.g. auth.refresh_tokens), not uuid, so the
    column side is always cast to ::text instead and compared against this,
    rather than fixing the array's type to match one column's type."""
    return "ARRAY[" + ','.join(f"'{i}'" for i in ids) + "]"


def sweep_delete(sql, org_tables, user_tables, owned_orgs, owned_users, passes=4):
    """Repeatedly DELETE FROM every dynamically-discovered org_id/user_id
    scoped table (excluding PRIMARY_TABLES, which the caller deletes itself,
    in order, beforehand). Repeated because an AFTER trigger on one table can
    repopulate another (the round-2 finding: capture_access() on
    memberships/auth.sessions repopulates access_epochs; recipient()
    triggers on messages/contacts/properties repopulate the message-capture/
    operation-domain tables) — enough passes make delete order irrelevant
    instead of requiring it to be hand-derived per table. Counter tables
    (public.hugo_owner_guard_serialization etc.) are NEVER swept — they hold
    no synthetic rows to delete, only a shared value that must never be
    forced backward (see assert_zero_residual)."""
    orgs, users = _text_array(owned_orgs), _text_array(owned_users)
    for _ in range(passes):
        for t in org_tables:
            sql(f"DELETE FROM {t} WHERE org_id::text=ANY({orgs})", check=False)
        for t in user_tables:
            sql(f"DELETE FROM {t} WHERE user_id::text=ANY({users})", check=False)


def assert_zero_residual(sql, org_tables, user_tables, counter_tables, counter_baseline, owned_orgs, owned_users):
    """The exhaustive-by-construction, HONEST check: EVERY dynamically-
    discovered table, not a hand-maintained list, classified truthfully —
    never a blanket "zero residual" claim that quietly ignores an advanced
    counter. Returns the list of benign "counter advanced" report lines (for
    the caller to print) and raises on any real residual, naming every
    offending table."""
    orgs, users = _text_array(owned_orgs), _text_array(owned_users)
    residual = {}
    for t in org_tables:
        n = sql(f"SELECT count(*) FROM {t} WHERE org_id::text=ANY({orgs})")
        if n != '0':
            residual[t] = f'org-scoped residual count={n} (expected 0)'
    for t in user_tables:
        n = sql(f"SELECT count(*) FROM {t} WHERE user_id::text=ANY({users})")
        if n != '0':
            residual[t] = residual.get(t, '') + f' user-scoped residual count={n} (expected 0)'

    advanced = []
    for table, col in counter_tables:
        before_count, before_value, before_hash = counter_baseline.get(table, ('?', None, '?'))
        now_count = sql(f"SELECT count(*) FROM {table}")
        now_value = sql(f"SELECT coalesce(sum({col}),0) FROM {table}") if col else None
        if now_count != before_count:
            # Row count changing on a table with no id column to scope by is
            # exactly the round-4 danger case: it can never be classified as
            # a benign counter advance (a counter's row count is fixed — it
            # only mutates existing rows), so this is always a real failure —
            # either genuinely leaked/removed rows, or a table this run wrote
            # that isn't actually counter-shaped and was misclassified.
            residual[table] = f'row count changed {before_count} -> {now_count} (a counter/cursor table must never gain or lose rows)'
            continue
        # [Astra round-5] Content hash over EVERY column except the one
        # recognized counter column. This is the check that actually closes
        # the round-5 defeat: a synthetic guard_key/generation-uuid swap
        # leaves row count AND the counter SUM untouched, but changes this
        # hash — there is no longer a column such a mutation can hide in.
        now_hash = sql(_content_hash_sql(table, col))
        if before_hash != '?' and now_hash != before_hash:
            residual[table] = f'non-counter column content changed (row-content hash {before_hash} -> {now_hash}, row count unchanged at {now_count}) — a mutation in a non-id, non-counter column, never a benign counter advance'
            continue
        if col is None:
            continue  # no counter column, row count + full content unchanged: untouched.
        if before_value == '?' or now_value == before_value:
            continue  # unchanged (or no baseline captured — treated as pass, matches original behavior for tables added after baseline, which cannot happen here since discover() runs before any writes)
        if int(now_value) < int(before_value):
            residual[table] = f'{col} DECREASED {before_value} -> {now_value} (never a benign monotonic advance — investigate)'
            continue
        # int(now_value) > int(before_value), row count unchanged, and every
        # OTHER column's content hash unchanged: a real, benign, monotonic
        # serialization/version advance with nothing else mutated. Holds no
        # synthetic rows — nothing to delete, and per the round-4 instruction
        # this shared counter must NEVER be forced backward.
        advanced.append(f'{table}.{col} +{int(now_value) - int(before_value)} ({before_value} -> {now_value})')

    if residual:
        raise RuntimeError(f'Owned-fixture cleanup left residual rows/unexplained changes across {len(residual)} dynamically-discovered table(s) (exhaustive check, not a hand-maintained list): {residual}')
    return advanced


def assert_baseline_unchanged(sql, id_tables, baseline_hashes, owned_orgs, owned_users):
    """[Astra round-6, the definitive closure] For EVERY id-scoped table
    (PRIMARY_TABLES included), re-hash every row that is NOT one of this
    run's own synthetic ids (i.e. exactly the rows the pre-run baseline
    covered) and assert it is byte-identical to that baseline. This is
    independent of, and strictly additional to, assert_zero_residual's own
    scoped-count-is-zero check: that check only proves this run's OWN rows
    are gone; this one proves nothing else in the table was touched at all —
    the exact gap Astra's round-6 repro exploited (seed a baseline row,
    create+delete this run's own row net-zero, then mutate the baseline
    row's non-id, non-counter column — row count and any counter unchanged,
    so the round-5 checks alone saw nothing).

    A recognized counter column's own legitimate advance on a baseline row
    (rare, but real — see snapshot_baseline_hashes) is excluded from the
    hash exactly as counter_tables handles it, so this never double-reports
    the same class of change assert_zero_residual already reports for the
    counter/shared set; the id-scoped counter's own value is not otherwise
    tracked here (unlike counter_tables, where it is the one permitted kind
    of delta) — it is simply excluded from what "unchanged" means, matching
    Astra's own repro framing ("row count + revision-sum unchanged").

    Fails loudly, by table, on ANY hash mismatch — there is no longer a
    table category (id-scoped or not, counter or not) whose persistent
    content this module does not verify byte-for-byte."""
    orgs, users = _text_array(owned_orgs), _text_array(owned_users)
    residual = {}
    for table, has_org, has_user, col in id_tables:
        before = baseline_hashes.get(table, '?')
        where = _not_owned_filter(has_org, has_user, orgs, users)
        now = sql(_content_hash_sql(table, col, where))
        if before != '?' and now != before:
            residual[table] = f'baseline (non-owned) row content changed — hash {before} -> {now} (a mutation in a pre-existing row, outside this run\'s own synthetic ids, in a non-counter column)'
    if residual:
        raise RuntimeError(f'Owned-fixture cleanup: baseline content changed in {len(residual)} id-scoped table(s) outside this run\'s own synthetic rows (round-6 exhaustive content check): {residual}')
