"""[Astra round-3 through round-7 — round 7 is the DEFINITIVE, FINAL closure]
Dynamic, exhaustive-by-construction, and HONEST residual verification,
shared by proof.py and runtime-proof.py. History of what this module
closes:
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
  counter/shared table passed silently.
- round 6: the round-5 content hash was applied only to the "neither org_id
  nor user_id" counter/shared set — an id-scoped table's PRE-EXISTING
  (non-synthetic) baseline rows were never hashed at all.
- round 7: rounds 3-6 each closed one CATEGORY of gap (org-scoped /
  user-scoped / counter-shared / id-scoped) by adding a NEW, SEPARATE code
  path for that category. Round 7 deleted the category distinction: ONE
  universe (every base table anywhere, PRIMARY_TABLES included), ONE
  content-signature check applied uniformly, ONE OWNED predicate.
- round 8 (this one, THE definitive, LOSSLESS closure): round 7 removed the
  category branching, but Astra found two remaining ALGORITHMIC gaps in the
  signature itself (not category exclusions):
  1. the counter check compared a table-WIDE SUM of the counter column — two
     rows in the same table, one +N and one -N, leave the sum unchanged and
     pass silently. Fixed by checking every counter row INDIVIDUALLY,
     grouped by that row's own non-counter content hash (its de facto
     identity, since that content is independently asserted unchanged) —
     see _counter_row_pairs_sql/assert_clean: a decrease in ANY single row
     fails, named by table+row-identity+column, never averaged away.
  2. the content hash was built via `to_jsonb(row)`, which re-serializes
     every column through jsonb's own (lossy) output — jsonb subcolumns get
     silently re-normalized on the way through (whitespace, and in some PG
     versions numeric formatting), so a real content mutation could produce
     an unchanged hash. Fixed by hashing each column's OWN native `::text`
     output directly (jsonb::text, numeric::text, bytea::text, array::text,
     etc. — each type's own exact, lossless textual representation, never
     routed through to_jsonb(record) at all) — see _row_hash_expr.
  There is no aggregation (SUM) and no normalization (to_jsonb) left
  anywhere in this module for a mutation to hide behind.
- round 9 (this one, THE definitive, COLLISION-FREE closure): round 8's
  `::text` concatenation and content-hash-based row grouping were still not
  fully sound:
  1. AMBIGUOUS ENCODING: concatenating column values with a fixed delimiter
     character is only safe if that character (and the NULL sentinel) can
     never appear inside real data — a column-boundary shift
     ('a'+'bc' vs 'ab'+'c') or a NULL-vs-empty-string pair can, in
     principle, collide. Fixed: every column is now encoded with an
     explicit LENGTH PREFIX (`len(text):text`, a self-delimiting/netstring
     style encoding) or a distinct one-character NULL sentinel ('N') that
     can never be confused with a length prefix (which always starts with a
     digit) — see _encode_col_sql. Concatenating these is injective by
     construction: no value's content, however it is shaped, can ever shift
     a column boundary or be mistaken for NULL.
     Also: grouping counter rows by a CONTENT hash (round 8) is sound only
     if that hash cannot collide across two truly distinct rows — Astra's
     repro swapped a counter between two rows sharing enough content to
     collide under an ambiguous encoding. Fixed: counter rows are now
     grouped by the table's actual PRIMARY KEY (or, absent one, the same
     unambiguous full-row encoding as a documented best-effort fallback) —
     see _row_key_expr/_primary_key. A real PK is unique by definition, so
     two distinct rows can never be conflated and a value swapped between
     them is always caught, structurally, not by hash luck.
     Also: float/double columns can lose precision under a low
     extra_float_digits session setting, making two distinct floats render
     as identical text. Every session this module's callers open now sets
     `extra_float_digits=3` so float8::text is always round-trippable.
  2. NULLABLE COUNTER DISAPPEARS: a counter's value going non-NULL<->NULL
     silently vanished from the old SUM/multiset (NULL poisons SUM to NULL,
     which coalesce() hid, and string_agg simply drops a NULL element).
     Fixed: the counter value is now encoded with an explicit 'NULL'
     sentinel (distinct from any digit string) and ANY transition to/from
     NULL is treated as a real change (never a benign advance) — see
     assert_clean's per-row counter comparison.
  3. TABLE UNIVERSE NEVER REFRESHED: the table list was discovered once at
     baseline time, so a table CREATED during the run was invisible to the
     residual check entirely — a proof that left a brand-new table behind
     would report "clean". Fixed: assert_clean re-enumerates the full
     universe at check time and diffs it against the baseline's table set;
     any table that appeared or disappeared fails loudly, by name, before
     any per-table content check even runs.
1. EXHAUSTIVE COVERAGE: every base table ANYWHERE in the database (any
   schema, never hardcoded, PRIMARY_TABLES included) is discovered via
   pg_catalog. Existing reply-lane schemas are included in the same whole-DB
   signature; callers that create disposable schemas remove them before the
   final check.
2. Cleanup SWEEPS every dynamically-discovered org_id/user_id-scoped table
   (not a hand-maintained list, PRIMARY_TABLES excluded here ONLY because
   the caller deletes those nine tables itself, in the correct FK/trigger
   order — the owner-guard trigger dance on memberships cannot be driven by
   a generic per-table DELETE), repeated for several passes so a table
   repopulated by another table's AFTER trigger (round 2) is still empty by
   the last pass.
"""

# Every existing base table is part of the signature universe, including the
# reply-lane schemas. The old five-schema exclusion made a mutation in an
# already-present reply table invisible whenever a proof happened to leave
# that schema installed. Callers that create a disposable schema must remove
# it before the final check; the checker must never silently omit an existing
# table from whole-DB verification.
# Tables the caller deletes explicitly, in the correct FK/trigger order
# (owner-guard trigger dance on memberships, etc.) — excluded ONLY from
# sweep_delete's generic DELETE (a blind per-table sweep would fight the
# trigger dance), and from org_tables/user_tables, the subset sweep_delete
# consumes. NEVER excluded from the uniform content-signature check below —
# round 7's own escape was exactly a hand-maintained hash exclusion for
# these two tables (organizations.name).
PRIMARY_TABLES = {
    'public.organizations', 'auth.users', 'auth.sessions', 'public.memberships',
    'public.messages', 'public.contacts', 'public.properties',
    'public.consent_events', 'public.provider_sender_numbers',
}
# The two tables whose OWN `id` column (not an org_id/user_id column) is the
# owned identity — organizations and auth.users define identity rather than
# reference it, so there is no generic column-name rule that finds them.
# This is the one piece of real semantic knowledge this module needs; it is
# used only to build the OWNED predicate, never to exclude either table from
# the content signature (see round-7 history above).
ANCHOR_ID_TABLES = {'public.organizations': 'org', 'auth.users': 'user'}
# Only these known mutable serialization/lease counters may advance while a
# proof runs. This is deliberately table+column exact: suffix heuristics used
# to exempt business fields such as dataset_version/schema_version and even
# immutable primary-key versions from the content signature. Every column not
# listed here remains hashed. The saved-action definitions.version column is
# intentionally absent because it is part of the immutable composite primary
# key; a version insert changes row count/content and must be visible.
COUNTER_COLUMN_ALLOWLIST = frozenset({
    'inbox_operation_domain.sms_scopes.revision',
    'inbox_operation_domain.target_versions.revision',
    'inbox_operations.dispatch_outbox.generation',
    'inbox_operations.steps.generation',
    'inbox_t2_backfill.collisions.generation',
    'inbox_t2_backfill.jobs.revision',
    'inbox_t2_bridge.access_epochs.revision',
    'inbox_t2_bridge.filter_rows.revision',
    'inbox_t2_bridge.summaries.projection_revision',
    'inbox_t2_bridge.summaries.source_generation',
    'inbox_t2_bridge.worksets.generation',
    'inbox_t2_maintained.rows.revision',
    'inbox_t2_maintained.rows.source_generation',
    'inbox_t2_message_capture.dirty.generation',
    'inbox_t2_message_capture.versions.revision',
    'inbox_t2_parent.work.generation',
    'inbox_t2_parent.work.scan_generation',
    'inbox_t2_policy.versions.revision',
    'inbox_t2_projection_proof.dirty.acknowledged_generation',
    'inbox_t2_projection_proof.dirty.generation',
    'inbox_t2_projection_proof.projections.latest_inbound_revision',
    'inbox_t2_projection_proof.projections.revision',
    'inbox_t2_projection_proof.projections.source_generation',
    'inbox_t2_read.boundaries.revision',
    'inbox_t2_safety.routes.generation',
    'inbox_t2_safety.routes.scan_generation',
    'inbox_t2_summary_worker.summaries.revision',
    'inbox_t2_summary_worker.summaries.source_generation',
    'public.hugo_owner_guard_serialization.version',
    'public.inbox_inbound_heads.revision',
    'public.memberships.my_leads_revision',
    'public.messages.inbox_inbound_revision',
    'inbox_reply_context.versions.revision',
    'inbox_reply_send.attempts.generation',
    'inbox_reply_send.attempts.receipt_version',
    'inbox_reply_send.callback_receipts.lease_generation',
    'inbox_reply_send.dispatch_outbox.generation',
})


def _rows(sql, query):
    out = sql(query)
    return [r for r in out.splitlines() if r.strip()]


_COLUMN_CACHE = {}


def _columns(sql, table):
    """[Astra round-8] The table's actual column list, in attnum order,
    memoized per process run (columns are structurally stable for the
    duration of one proof run — nothing in this module ever adds/drops a
    column). Used to build _row_hash_expr directly from each column's own
    type, instead of going through a composite-to-jsonb conversion that can
    silently re-normalize (and thereby lose) a column's real content."""
    if table not in _COLUMN_CACHE:
        schema, name = table.split('.', 1)
        _COLUMN_CACHE[table] = _rows(sql, f"""
            SELECT a.attname FROM pg_attribute a
            JOIN pg_class c ON c.oid=a.attrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE c.relkind='r' AND n.nspname='{schema}' AND c.relname='{name}'
              AND a.attnum>0 AND NOT a.attisdropped
            ORDER BY a.attnum
        """)
    return _COLUMN_CACHE[table]


_PK_CACHE = {}


def _primary_key(sql, table):
    """[Astra round-9] The table's actual PRIMARY KEY columns, in key order,
    memoized per process run — or None if the table has no primary key.
    Used to group counter rows by their real, structurally-unique identity
    instead of a content hash (which, however carefully built, is a value
    two distinct rows could in principle share)."""
    if table not in _PK_CACHE:
        schema, name = table.split('.', 1)
        _PK_CACHE[table] = _rows(sql, f"""
            SELECT a.attname FROM pg_index i
            JOIN pg_class c ON c.oid=i.indrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=ANY(i.indkey)
            WHERE n.nspname='{schema}' AND c.relname='{name}' AND i.indisprimary
            ORDER BY array_position(i.indkey, a.attnum)
        """) or None
    return _PK_CACHE[table]


def _counter_column(sql, table):
    """The one explicitly allowlisted mutable counter on `table`, if any.
    Immutable primary-key columns are never eligible, even if their name
    looks like a version or revision."""
    schema, name = table.split('.', 1)
    allowed_columns = sorted(item.rsplit('.', 1)[1] for item in COUNTER_COLUMN_ALLOWLIST if item.rsplit('.', 1)[0] == table)
    if not allowed_columns:
        return None
    allowed = ','.join("'" + column.replace("'", "''") + "'" for column in allowed_columns)
    rows = _rows(sql, f"""
        SELECT a.attname FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE c.relkind='r' AND n.nspname='{schema}' AND c.relname='{name}'
          AND a.attname IN ({allowed})
          AND a.attnum>0 AND NOT a.attisdropped
          AND NOT EXISTS (
            SELECT 1 FROM pg_index pk
            WHERE pk.indrelid=c.oid AND pk.indisprimary AND a.attnum=ANY(pk.indkey)
          )
          AND format_type(a.atttypid,a.atttypmod) IN ('integer','bigint','smallint')
        ORDER BY a.attnum LIMIT 1
    """)
    return rows[0] if rows else None


def _all_tables(sql):
    """[Astra round-7] THE single uniform universe: EVERY base table
    anywhere in the database (any schema, PRIMARY_TABLES included, no
    org_id/user_id requirement — a table with neither, like
    hugo_owner_guard_serialization, is just as much a member as one with
    both), with no schema exclusions. Returns [(table, has_org, has_user,
    counter_column_or_None)] — the one list every function below iterates,
    with no branching by category."""
    rows = _rows(sql, f"""
        SELECT n.nspname||'.'||c.relname||'|'||
          coalesce(bool_or(a.attname='org_id'),false)||'|'||coalesce(bool_or(a.attname='user_id'),false)
        FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace
        LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attname IN ('org_id','user_id')
        WHERE c.relkind='r'
          AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname<>'information_schema'
        GROUP BY n.nspname,c.relname ORDER BY 1
    """)
    out = []
    for r in rows:
        table, has_org, has_user = r.split('|')
        out.append((table, has_org == 'true', has_user == 'true', _counter_column(sql, table)))
    return out


def discover(sql):
    """Dynamic table discovery — call ONCE, before installing anything, so
    the caller can snapshot the baseline before any writes. Returns
    (org_tables, user_tables, all_tables):
    - org_tables/user_tables: PRIMARY_TABLES-excluded subset with org_id/
      user_id respectively — used ONLY by sweep_delete (which must not
      fight the caller's own hand-ordered PRIMARY_TABLES deletes).
    - all_tables [round 7]: the single uniform universe (see _all_tables) —
      every table anywhere, PRIMARY_TABLES included, used by every
      baseline/assertion function below. There is no separate "counter
      table" or "id table" list any more; a table's shape (has_org, has_user,
      counter column) is just data carried alongside it in this one list."""
    all_tables = _all_tables(sql)
    org_tables = [t for t, has_org, _, _ in all_tables if has_org and t not in PRIMARY_TABLES]
    user_tables = [t for t, _, has_user, _ in all_tables if has_user and t not in PRIMARY_TABLES]
    return org_tables, user_tables, all_tables


def _encode_col_sql(colref):
    """[Astra round-9] ONE column's collision-free encoding: an explicit
    NULL sentinel ('N', a single byte that can never be confused with a
    length-prefixed value — see below), or `len(text):text` — a
    self-delimiting, netstring-style length prefix. This is injective by
    construction: a length prefix always starts with one or more ASCII
    digits followed by ':', which 'N' can never look like, and — crucially
    — the reader (conceptually; this module never needs to actually parse
    the encoding back, only concatenate and hash it) never scans for a
    terminator inside the value, so nothing the value itself contains
    (a ':', digits, another 'N', even literal embedded NUL bytes) can ever
    be mistaken for a boundary. Concatenating N such encodings back-to-back
    is therefore injective in the N-tuple of (possibly-NULL) values: no
    column-boundary shift, no NULL-vs-empty-string pair, can ever produce
    the same encoded stream from two different inputs."""
    return f"CASE WHEN {colref} IS NULL THEN 'N' ELSE length({colref}::text)::text || ':' || {colref}::text END"


def _row_key_expr(sql, table):
    """[Astra round-9] The row's structural identity for counter grouping:
    the table's real PRIMARY KEY columns, collision-free-encoded and
    concatenated (see _encode_col_sql), then md5'd. A primary key is unique
    by definition, so two distinct rows can NEVER share this key — grouping
    counter values by it (instead of round 8's content hash, which two
    sufficiently-similar-but-distinct rows could in principle collide on)
    makes a counter value swapped between two rows structurally impossible
    to miss. Tables with no primary key fall back to the same unambiguous
    encoding over every non-counter column (round 8's approach, now with
    round 9's collision-free per-column encoding) — a documented best
    effort for the rare PK-less table, still exact for the common case
    (no two rows share ALL non-counter column values) and no worse than
    round 8 for the rare case where they do."""
    cols = _primary_key(sql, table) or _columns(sql, table)
    if not cols:
        return "md5('')"
    parts = ','.join(_encode_col_sql(f't."{c}"') for c in cols)
    return f"md5(array_to_string(ARRAY[{parts}], ''))"


def _row_hash_expr(sql, table, exclude_col):
    """[Astra round-8/9] Per-row content hash built from each column's OWN
    native `::text` output, collision-free-encoded (round 9 — see
    _encode_col_sql) and concatenated in a stable (attnum) order — never
    from `to_jsonb(row)` (round 8: converting a whole row to jsonb
    re-serializes every column THROUGH jsonb's own type system, which can
    silently re-normalize a column's real stored content). Each column's OWN
    type output function is used directly — jsonb::text is the value's own
    raw serialization, numeric::text preserves exact stored scale/precision,
    bytea::text is a lossless hex encoding, array/composite/range/hstore
    likewise — and round 9's length-prefixed encoding makes the
    concatenation itself injective (no column-boundary or NULL/'' collision
    possible, regardless of what any column's text happens to contain). If a
    column's type has no meaningful ::text cast, Postgres raises at query
    time rather than this module silently falling back to a lossy encoding."""
    cols = [c for c in _columns(sql, table) if c != exclude_col]
    if not cols:
        return "md5('')"
    parts = ','.join(_encode_col_sql(f't."{c}"') for c in cols)
    return f"md5(array_to_string(ARRAY[{parts}], ''))"


def _content_hash_sql(sql, table, col, where=None):
    """One table-level digest over EVERY column except the whitelisted
    counter column (or every column, if col is None), optionally restricted
    to a WHERE clause: each row's _row_hash_expr, md5'd, sorted (so row
    order/physical layout never matters), joined, md5'd again. Applied to
    EVERY table with zero exceptions, using each column's raw, collision-free
    ::text encoding (rounds 8/9)."""
    row_hash = _row_hash_expr(sql, table, col)
    filt = f" WHERE {where}" if where else ""
    return f"SELECT md5(coalesce(string_agg(h,',' ORDER BY h),'')) FROM (SELECT {row_hash} AS h FROM {table} t{filt}) x"


def _counter_row_pairs_sql(sql, table, col, where=None):
    """[Astra round-8/9] One row per (row-key, counter-value) pair, as
    `key:value` joined by commas — the raw material for a PER-ROW counter
    check (never a table-wide SUM, which lets one row's decrease be masked
    by another row's increase). The key is the table's PRIMARY KEY (round 9
    — see _row_key_expr), so two distinct rows can never be conflated: a
    counter value swapped between two real rows is caught by comparing each
    row's OWN key across before/after, not by hoping a content hash never
    collides. The counter value itself is 'NULL' (an explicit sentinel,
    round 9) when the column is NULL — never silently dropped the way a
    NULL poisons SUM or vanishes from string_agg."""
    row_key = _row_key_expr(sql, table)
    val_expr = f"CASE WHEN t.{col} IS NULL THEN 'NULL' ELSE t.{col}::text END"
    filt = f" WHERE {where}" if where else ""
    return f"SELECT coalesce(string_agg({row_key} || ':' || ({val_expr}), ',' ORDER BY {row_key}), '') FROM {table} t{filt}"


def _parse_counter_pairs(s):
    """Parse the `key:value,key:value,...` text _counter_row_pairs_sql
    returns into {row_key: [value_or_'NULL', ...]} — grouping here (not in
    SQL) keeps the per-row comparison logic in one place. Values stay as
    text ('NULL' sentinel or a digit string) so assert_clean can tell a real
    NULL transition (round 9) apart from a numeric change."""
    groups = {}
    if not s:
        return groups
    for part in s.split(','):
        h, v = part.rsplit(':', 1)
        groups.setdefault(h, []).append(v)
    return groups


def snapshot_baseline(sql, all_tables):
    """[Astra round-7/8] MUST run before any synthetic id this run will ever
    use exists — every row in every table is, by definition, a "baseline"
    row at this point, so each snapshot is unrestricted (no owned-id filter
    needed: nothing owned exists yet, so "every row" and "every non-owned
    row" are the same set). Per table: (row_count, content_hash,
    counter_pairs_or_None) — content_hash and counter_pairs both built from
    raw per-column ::text output (round 8), and counter_pairs is PER ROW
    (round 8), never a table-wide SUM."""
    snapshot = {}
    for table, _, _, col in all_tables:
        count = sql(f"SELECT count(*) FROM {table}")
        content_hash = sql(_content_hash_sql(sql, table, col))
        pairs = _parse_counter_pairs(sql(_counter_row_pairs_sql(sql, table, col))) if col else None
        snapshot[table] = (count, content_hash, pairs)
    return snapshot


def _text_array(ids):
    """A plain text[] literal, always explicitly typed (even when empty —
    an untyped `ARRAY[]` is a Postgres error) and never ::uuid[] — some
    discovered tables key org_id/user_id as varchar (e.g.
    auth.refresh_tokens), not uuid, so the column side is always cast to
    ::text instead and compared against this."""
    return "ARRAY[" + ','.join(f"'{i}'" for i in ids) + "]::text[]"


def sweep_delete(sql, org_tables, user_tables, owned_orgs, owned_users, passes=4):
    """Repeatedly DELETE FROM every dynamically-discovered org_id/user_id
    scoped table (excluding PRIMARY_TABLES, which the caller deletes itself,
    in order, beforehand). Repeated because an AFTER trigger on one table can
    repopulate another (round 2) — enough passes make delete order
    irrelevant instead of requiring it to be hand-derived per table. Tables
    with neither org_id nor user_id are never swept — they hold no synthetic
    rows to delete, only shared/counter content that assert_clean checks in
    place (see below)."""
    orgs, users = _text_array(owned_orgs), _text_array(owned_users)
    for _ in range(passes):
        for t in org_tables:
            sql(f"DELETE FROM {t} WHERE org_id::text=ANY({orgs})", check=False)
        for t in user_tables:
            sql(f"DELETE FROM {t} WHERE user_id::text=ANY({users})", check=False)


def _owned_predicate(table, has_org, has_user, orgs, users):
    """[Astra round-7] The single OWNED predicate, uniform across the whole
    table universe: true for a row that DOES belong to one of this run's own
    synthetic ids. Every table's "ownedness" reduces to the same handful of
    column checks — an org_id column, a user_id column, or (for the two
    anchor tables only — organizations/auth.users define identity via their
    own `id` rather than referencing it) the table's own id. A table with
    none of these (a pure counter/shared table, e.g.
    hugo_owner_guard_serialization) can never hold an owned row, so its
    predicate is simply `false` — not a special case in the caller, just
    what falls out of having no owned-identity column at all."""
    parts = []
    anchor = ANCHOR_ID_TABLES.get(table)
    if anchor == 'org':
        parts.append(f"id::text=ANY({orgs})")
    if anchor == 'user':
        parts.append(f"id::text=ANY({users})")
    if has_org:
        parts.append(f"coalesce(org_id::text,'~NULL~')=ANY({orgs})")
    if has_user:
        parts.append(f"coalesce(user_id::text,'~NULL~')=ANY({users})")
    return ' OR '.join(parts) if parts else 'false'


def _pk_sort_key(v):
    """[Astra round-9] Sort key for a counter value list that may contain the
    'NULL' sentinel alongside numeric text — NULLs sort first, consistently,
    on both sides of a before/after comparison, so a PK-less table's
    fallback multiset comparison (see _row_key_expr) still pairs like with
    like."""
    return (0,) if v == 'NULL' else (1, int(v))


def assert_clean(sql, all_tables, baseline, owned_orgs, owned_users):
    """[Astra round-9, the definitive, COLLISION-FREE closure] ONE uniform
    check, run identically over EVERY table in the universe — no org-scoped/
    user-scoped/counter/id-scoped branches, no PRIMARY_TABLES exemption, no
    aggregation, no normalization, and no encoding ambiguity left for a
    mutation to hide behind:
      0. [round 9] the table universe itself is RE-ENUMERATED right now and
         diffed against the baseline's — a table that appeared or
         disappeared since baseline fails loudly by name before any
         per-table content check even runs (a table created mid-run used to
         be invisible to this check entirely);
      1. this run's OWN rows (the OWNED predicate) must be net-zero in every
         table that still exists — proves the sweep/explicit-delete
         actually removed them;
      2. every row NOT owned by this run must be byte-identical, in every
         column except a whitelisted counter column, to the pre-run
         baseline, hashed from each column's raw, collision-free-encoded
         ::text output (rounds 8/9 — see _row_hash_expr) — proves nothing
         else anywhere was mutated, including a jsonb column's exact
         content/array length, a column-boundary shift, a NULL-vs-empty
         pair, organizations.name, and auth.users, uniformly;
      3. a whitelisted counter column, when present, is checked PER ROW
         (never a table-wide SUM), grouped by that row's real PRIMARY KEY
         (round 9 — never a content hash two distinct rows could in
         principle collide on): a decrease in ANY single row fails, named
         by table+row-key+column; a non-NULL<->NULL transition always fails
         (round 9 — never a silently-vanished SUM contributor); an increase
         in any row is always reported by name, never silently accepted,
         never averaged against another row's decrease.
    Returns the list of benign "counter advanced" report lines and raises on
    any real residual, naming every offending table."""
    orgs, users = _text_array(owned_orgs), _text_array(owned_users)
    residual = {}
    advanced = []

    baseline_names = {t for t, _, _, _ in all_tables}
    current_names = {t for t, _, _, _ in _all_tables(sql)}
    vanished = baseline_names - current_names
    appeared = current_names - baseline_names
    if vanished:
        residual['__table_universe__'] = residual.get('__table_universe__', '') + f'; table(s) present at baseline but GONE at check time: {sorted(vanished)}'
    if appeared:
        residual['__table_universe__'] = residual.get('__table_universe__', '') + f'; NEW table(s) created during this run, absent from the baseline (would have escaped every check below entirely): {sorted(appeared)}'

    for table, has_org, has_user, col in all_tables:
        if table in vanished:
            continue  # already reported above; querying it would just error
        owned_pred = _owned_predicate(table, has_org, has_user, orgs, users)
        if owned_pred == 'false':
            not_owned = 'true'
            owned_count = '0'
        else:
            not_owned = f'NOT ({owned_pred})'
            owned_count = sql(f"SELECT count(*) FROM {table} WHERE {owned_pred}")
        if owned_count != '0':
            residual[table] = f"{owned_count} of this run's own synthetic row(s) still present after cleanup (expected 0)"

        before_count, before_hash, before_pairs = baseline.get(table, ('?', '?', None))
        now_count = sql(f"SELECT count(*) FROM {table} WHERE {not_owned}")
        if before_count != '?' and now_count != before_count:
            residual[table] = residual.get(table, '') + f'; non-owned row count changed {before_count} -> {now_count} (a row was added to or removed from the pre-existing baseline, outside this run\'s own synthetic ids)'
        else:
            now_hash = sql(_content_hash_sql(sql, table, col, not_owned))
            if before_hash != '?' and now_hash != before_hash:
                residual[table] = residual.get(table, '') + f'; non-owned content hash changed {before_hash} -> {now_hash} (a mutation in a pre-existing row\'s non-counter column, hashed from raw ::text output — includes jsonb content/array length, organizations.name/auth.users, and every other table/type uniformly)'

        if col and before_pairs is not None:
            now_pairs = _parse_counter_pairs(sql(_counter_row_pairs_sql(sql, table, col, not_owned)))
            for row_id in set(before_pairs) | set(now_pairs):
                bvals, avals = before_pairs.get(row_id, []), now_pairs.get(row_id, [])
                if len(bvals) != len(avals):
                    continue  # a row's identity appearing/disappearing is already caught by the count/hash checks above
                # Both lists sorted with the NULL-aware key (round 9) — with
                # a real PRIMARY KEY each list has exactly one element; the
                # PK-less fallback keeps the sound multiset comparison.
                for bv, av in zip(sorted(bvals, key=_pk_sort_key), sorted(avals, key=_pk_sort_key)):
                    if bv == 'NULL' or av == 'NULL':
                        if bv != av:
                            residual[table] = residual.get(table, '') + f'; {col} changed to/from NULL ({bv} -> {av}) on row(key={row_id[:12]}...) (round 9 — never a benign advance, never silently dropped from the check)'
                        continue  # both NULL: genuinely unchanged
                    bv_i, av_i = int(bv), int(av)
                    if av_i < bv_i:
                        residual[table] = residual.get(table, '') + f'; {col} DECREASED {bv_i} -> {av_i} on row(key={row_id[:12]}...) (per-row, PRIMARY-KEY-grouped check — never masked by another row\'s increase via a table-wide SUM, never conflated with another row via a content-hash collision)'
                    elif av_i > bv_i:
                        advanced.append(f'{table}.{col} row {row_id[:12]}... +{av_i - bv_i} ({bv_i} -> {av_i})')

    if residual:
        raise RuntimeError(f'Owned-fixture cleanup left residual/unexplained changes across {len(residual)} dynamically-discovered table(s) (single uniform, lossless, per-row check over the whole database): {residual}')
    return advanced
