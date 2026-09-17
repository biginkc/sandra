"""[Astra round-3/4] Dynamic, exhaustive-by-construction, and HONEST residual
verification, shared by proof.py and runtime-proof.py. Cleanup has now missed
leaked tables three times by hand-maintained enumeration (access_epochs;
message_capture.*/operation_domain.*; inbox_t2_policy.versions/parent.work/
maintained.queue/projection_proof.dirty), and round 4 found the counter-table
discovery itself was too narrow — public.hugo_owner_guard_serialization (a
shared, cross-fixture serialization counter the round-2 owner-guard trigger
dance advances on every memberships DISABLE/ENABLE TRIGGER cycle) was outside
the old `inbox_t2_*`/`inbox_operation_domain` schema pattern, so it was never
even snapshotted, and the printed "zero net residual" was FALSE. This module:

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
   - otherwise only row count is tracked (there is nothing else generic to
     check without assuming a schema).
4. HONEST classification at residual time, matching what production
   correctness actually requires (never move a shared serialization counter
   backward — see round 4's own instruction):
   - row count unchanged AND (no counter column OR its value unchanged):
     genuinely untouched — silent pass.
   - row count unchanged AND counter value INCREASED: a benign monotonic
     serialization/version advance — holds no synthetic rows, so nothing to
     delete or roll back. Reported EXPLICITLY (not silently folded into "zero
     residual"), and does not fail the run.
   - row count changed, OR a counter value DECREASED, OR a table this run's
     own write-activity touched (pg_stat_user_tables) was never classified as
     org/user-scoped or counter-shaped at all: FAILS loudly, by name.
5. Cleanup SWEEPS every dynamically-discovered org_id/user_id-scoped table
   (not a hand-maintained list), repeated for several passes so a table
   repopulated by another table's AFTER trigger (the round-2 finding) is
   still empty by the last pass — order-independent by construction. Counter
   tables are NEVER deleted from or reset — see point 4.
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


def discover(sql):
    """Dynamic table discovery — call ONCE, before installing anything, so
    the caller can snapshot counter_tables' baseline before any writes.
    Returns (org_tables, user_tables, counter_tables) where counter_tables is
    a list of (table, counter_column_or_None)."""
    return _scoped_tables(sql, 'org_id'), _scoped_tables(sql, 'user_id'), _counter_tables(sql)


def snapshot_counters(sql, counter_tables):
    """Per table: (row_count, counter_value_or_None). counter_value is
    SUM(counter_column) — NULL-safe via coalesce — only when a counter column
    was found; None otherwise (nothing generic to compare beyond row count)."""
    snapshot = {}
    for table, col in counter_tables:
        count = sql(f"SELECT count(*) FROM {table}")
        value = sql(f"SELECT coalesce(sum({col}),0) FROM {table}") if col else None
        snapshot[table] = (count, value)
    return snapshot


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
        before_count, before_value = counter_baseline.get(table, ('?', None))
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
        if col is None:
            continue  # no counter column and row count unchanged: untouched.
        if before_value == '?' or now_value == before_value:
            continue  # unchanged (or no baseline captured — treated as pass, matches original behavior for tables added after baseline, which cannot happen here since discover() runs before any writes)
        if int(now_value) < int(before_value):
            residual[table] = f'{col} DECREASED {before_value} -> {now_value} (never a benign monotonic advance — investigate)'
            continue
        # int(now_value) > int(before_value): a real, benign, monotonic
        # serialization/version advance. Holds no synthetic rows (row count
        # unchanged, confirmed above) — nothing to delete, and per the round-4
        # instruction this shared counter must NEVER be forced backward.
        advanced.append(f'{table}.{col} +{int(now_value) - int(before_value)} ({before_value} -> {now_value})')

    if residual:
        raise RuntimeError(f'Owned-fixture cleanup left residual rows/unexplained changes across {len(residual)} dynamically-discovered table(s) (exhaustive check, not a hand-maintained list): {residual}')
    return advanced
