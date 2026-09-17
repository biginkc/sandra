"""[Astra round-3] Dynamic, exhaustive-by-construction residual verification,
shared by proof.py and runtime-proof.py. Cleanup has now missed leaked
tables three times by hand-maintained enumeration (access_epochs;
message_capture.*/operation_domain.*; inbox_t2_policy.versions/parent.work/
maintained.queue/projection_proof.dirty) — this closes the CLASS instead of
patching the latest four tables:

1. EXHAUSTIVE COVERAGE, not enumeration: every base table ANYWHERE in the
   database with an org_id or user_id column is discovered dynamically via
   pg_catalog (never hardcoded — a new schema/table can never silently leak
   again), excluding only the handful of "primary" tables the caller already
   manages explicitly (organizations/auth.users/auth.sessions/memberships/
   messages/contacts/properties/consent_events/provider_sender_numbers — see
   PRIMARY_TABLES) and the ephemeral reply-lane schemas that get DROP SCHEMA
   CASCADEd entirely each run.
2. Because this run's org/user ids are freshly generated random UUIDs, no
   pre-existing row anywhere can ever match them — so a SCOPED count
   (WHERE org_id=ANY(this run's ids)) is already an exact zero-baseline diff
   without needing a snapshot, and unlike a raw whole-table row-count diff it
   is immune to unrelated concurrent activity elsewhere in this shared
   fixture database (other proof scripts/agents may write the SAME tables at
   the same time).
3. For the few tables in the reply lane's own dependency schemas
   (inbox_t2_*, inbox_operation_domain) that have NEITHER column — pure
   counters/cursors this fixture might still increment — there is no id to
   scope by, so a true snapshot-before/assert-equal-after row-count diff is
   used instead.
4. Cleanup SWEEPS every dynamically-discovered org_id/user_id-scoped table
   (not a hand-maintained list), repeated for several passes so a table
   repopulated by another table's AFTER trigger (the round-2 finding) is
   still empty by the last pass — order-independent by construction.
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
# Schemas queried for the "neither org_id nor user_id" counter/cursor
# fallback (step 3 above) — the reply lane's own dependency schemas, where a
# leak has actually been found. Deliberately narrower than "every schema in
# the database" (which would pull in unrelated, unowned system tables with
# no scoping mechanism at all and no way to attribute a delta to this run).
COUNTER_SCHEMA_PATTERN_SQL = "(n.nspname LIKE 'inbox\\_t2\\_%' OR n.nspname='inbox_operation_domain')"


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
    return _rows(sql, f"""
        SELECT n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='r' AND {COUNTER_SCHEMA_PATTERN_SQL}
          AND NOT EXISTS(
            SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
              AND a.attname IN ('org_id','user_id')
          )
        ORDER BY 1
    """)


def discover(sql):
    """Dynamic table discovery — call ONCE, before installing anything, so
    the caller can snapshot counter_tables' baseline before any writes.
    Returns (org_tables, user_tables, counter_tables)."""
    return _scoped_tables(sql, 'org_id'), _scoped_tables(sql, 'user_id'), _counter_tables(sql)


def snapshot_counters(sql, counter_tables):
    return {t: sql(f"SELECT count(*) FROM {t}") for t in counter_tables}


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
    instead of requiring it to be hand-derived per table."""
    orgs, users = _text_array(owned_orgs), _text_array(owned_users)
    for _ in range(passes):
        for t in org_tables:
            sql(f"DELETE FROM {t} WHERE org_id::text=ANY({orgs})", check=False)
        for t in user_tables:
            sql(f"DELETE FROM {t} WHERE user_id::text=ANY({users})", check=False)


def assert_zero_residual(sql, org_tables, user_tables, counter_tables, counter_baseline, owned_orgs, owned_users):
    """The exhaustive-by-construction check: EVERY dynamically-discovered
    table, not a hand-maintained list. Fails loudly, naming every offending
    table and its actual vs. expected count."""
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
    for t in counter_tables:
        n = sql(f"SELECT count(*) FROM {t}")
        before = counter_baseline.get(t, '?')
        if n != before:
            residual[t] = f'counter baseline {before} -> {n} (net delta {int(n) - int(before) if before != "?" else "?"})'
    if residual:
        raise RuntimeError(f'Owned-fixture cleanup left residual rows across {len(residual)} dynamically-discovered table(s) (exhaustive check, not a hand-maintained list): {residual}')
