-- Additive current-workset update probe.  This is installer/rehearsal SQL only;
-- it is not a supabase migration and must run only on the explicitly marked
-- release database.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '20s';

DO $$
BEGIN
  IF current_user <> 'postgres'
     OR current_database() <> 'sandra_inbox_release_20260917'
     OR NOT EXISTS (
       SELECT 1 FROM install_fixture.identity
       WHERE marker = 'sandra-inbox-release-owned-synthetic'
     ) THEN
    RAISE EXCEPTION 'Owned release fixture required';
  END IF;
END;
$$;

-- `source_cursor_bound=false` is deliberately distinct from a first-page
-- origin (`true` + source_cursor_id IS NULL).  Pre-upgrade worksets therefore
-- cannot be interpreted as first-page snapshots by the probe; they require an
-- explicit user refresh that creates a new scope with this metadata.
ALTER TABLE inbox_bridge.worksets
  ADD COLUMN IF NOT EXISTS source_cursor_id uuid,
  ADD COLUMN IF NOT EXISTS source_cursor_bound boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS source_page_limit integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inbox_bridge.worksets'::regclass
      AND conname = 'worksets_source_cursor_origin_check'
  ) THEN
    ALTER TABLE inbox_bridge.worksets
      ADD CONSTRAINT worksets_source_cursor_origin_check
      CHECK (source_cursor_bound OR source_cursor_id IS NULL);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inbox_bridge.worksets'::regclass
      AND conname = 'worksets_source_page_limit_check'
  ) THEN
    ALTER TABLE inbox_bridge.worksets
      ADD CONSTRAINT worksets_source_page_limit_check
      CHECK (source_page_limit IS NULL OR source_page_limit BETWEEN 1 AND 500);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'inbox_bridge.worksets'::regclass
      AND conname = 'worksets_source_origin_complete_check'
  ) THEN
    ALTER TABLE inbox_bridge.worksets
      ADD CONSTRAINT worksets_source_origin_complete_check
      CHECK (NOT source_cursor_bound OR source_page_limit IS NOT NULL);
  END IF;
END;
$$;

-- Preserve the reviewed v2 creation semantics.  The only new write is the
-- immutable page-origin binding captured in the same INSERT as the workset;
-- cursor authorization and scope replacement remain owned by this transaction.
CREATE OR REPLACE FUNCTION public.inbox_create_workset_v2(
  org_id uuid,
  filter jsonb,
  "limit" integer,
  replaces_scope_id uuid DEFAULT NULL,
  cursor_id uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
SET statement_timeout = '20s'
AS $$
DECLARE
  a jsonb;
  u uuid;
  sid uuid;
  e bigint;
  now_at timestamptz;
  prior inbox_bridge.worksets;
  created inbox_bridge.worksets;
  ids jsonb;
  gen bigint;
  last_at timestamptz;
  f jsonb;
  n integer := "limit";
  replaces uuid := replaces_scope_id;
  cur inbox_bridge.cursor_context;
  page_rows jsonb;
  last_row jsonb;
  next_id uuid;
BEGIN
  f := inbox_bridge.normalize_filter(filter);
  IF n IS NULL OR n < 1 OR n > 500 THEN
    RAISE EXCEPTION 'INBOX_INVALID_WORKSET' USING ERRCODE = '22023';
  END IF;

  a := inbox_bridge.authorize_serving(org_id);
  u := (a->>'user_id')::uuid;
  sid := (a->>'session_id')::uuid;

  -- Persistent actor row serializes generation allocation, access capture,
  -- cursor-origin validation, and replacement.
  PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id = u FOR UPDATE;
  a := inbox_bridge.authorize_serving(org_id);
  e := (a->>'access_epoch')::bigint;
  now_at := clock_timestamp();

  SELECT max(generation), max(created_at)
    INTO gen, last_at
    FROM inbox_bridge.worksets
   WHERE user_id = u AND session_id = sid;
  IF last_at > now_at - interval '1 second' THEN
    RAISE EXCEPTION 'INBOX_GENERATION_RATE' USING ERRCODE = '55000';
  END IF;

  IF replaces IS NOT NULL THEN
    SELECT * INTO prior FROM inbox_bridge.worksets WHERE id = replaces FOR UPDATE;
    IF NOT FOUND
       OR prior.user_id <> u
       OR prior.session_id <> sid
       OR prior.org_id <> org_id
       OR prior.access_epoch <> e
       OR prior.revoked THEN
      RAISE EXCEPTION 'INBOX_REPLACEMENT_DENIED' USING ERRCODE = '42501';
    END IF;
  END IF;

  IF (
    SELECT count(*)
      FROM inbox_bridge.worksets
     WHERE user_id = u
       AND session_id = sid
       AND NOT revoked
       AND expires_at > now_at
       AND id IS DISTINCT FROM replaces
  ) >= 2 THEN
    RAISE EXCEPTION 'INBOX_GENERATION_LIMIT' USING ERRCODE = '55000';
  END IF;

  IF cursor_id IS NOT NULL THEN
    SELECT w.id, w.org_id, w.user_id, w.session_id, w.access_epoch,
           w.generation, w.created_at, w.expires_at, w.filter, w.targets,
           w.handles, w.revoked, c.latest_at AS cursor_at,
           c.target_kind AS cursor_kind, c.target_id AS cursor_target
      INTO cur
      FROM inbox_bridge.cursors c
      JOIN inbox_bridge.worksets w ON w.id = c.scope_id
     WHERE c.id = cursor_id;
    IF NOT FOUND
       OR cur.user_id <> u
       OR cur.session_id <> sid
       OR cur.org_id <> org_id
       OR cur.access_epoch <> e
       OR cur.expires_at <= now_at
       OR cur.revoked
       OR cur.filter IS DISTINCT FROM f THEN
      RAISE EXCEPTION 'INBOX_CURSOR_DENIED' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT coalesce(
           jsonb_agg(to_jsonb(rows) ORDER BY latest_at DESC NULLS LAST,
                    target_kind, target_id), '[]'::jsonb
         )
    INTO page_rows
    FROM (
      SELECT *
        FROM inbox_bridge.page(
          org_id,
          u,
          f,
          cur.cursor_at,
          cur.cursor_kind,
          cur.cursor_target,
          cursor_id IS NOT NULL,
          n + 1
        )
    ) rows;

  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object('kind', x->>'target_kind', 'id', x->>'target_id')
             ORDER BY ordinal
           ), '[]'::jsonb
         )
    INTO ids
    FROM jsonb_array_elements(page_rows) WITH ORDINALITY elements(x, ordinal)
   WHERE ordinal <= n;

  INSERT INTO inbox_bridge.worksets(
    org_id, user_id, session_id, access_epoch, generation,
    created_at, expires_at, filter, targets, handles,
    source_cursor_id, source_cursor_bound, source_page_limit
  )
  VALUES (
    org_id, u, sid, e, coalesce(gen, 0) + 1,
    now_at,
    least(now_at + interval '15 minutes', (a->>'expires_at')::timestamptz),
    f,
    ids,
    (
      SELECT jsonb_agg(null::text)
        FROM generate_series(1, greatest(1, (jsonb_array_length(ids) + 99) / 100))
    ),
    cursor_id,
    true,
    n
  )
  RETURNING * INTO created;

  IF replaces IS NOT NULL THEN
    UPDATE inbox_bridge.worksets SET revoked = true WHERE id = replaces;
  END IF;

  IF jsonb_array_length(page_rows) > n THEN
    last_row := page_rows->(n - 1);
    INSERT INTO inbox_bridge.cursors(scope_id, latest_at, target_kind, target_id)
    VALUES (
      created.id,
      (last_row->>'latest_at')::timestamptz,
      last_row->>'target_kind',
      (last_row->>'target_id')::uuid
    )
    RETURNING id INTO next_id;
  END IF;

  RETURN inbox_bridge.scope_json(created)
      || jsonb_build_object(
           'next_cursor', next_id,
           'refreshed', cursor_id IS NOT NULL
         );
END;
$$;

-- A probe never writes worksets, cursors, handles, or projection rows.  It
-- reads the source cursor captured by the creation transaction, re-checks the
-- current authenticated organization/session/epoch, and compares only the
-- bounded page represented by this scope.  A revoked source scope is allowed
-- as an origin: replacing a page revokes its predecessor but must not erase
-- the cursor required to observe that same page again.
CREATE FUNCTION inbox_bridge.probe_current_workset(scope_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
SET statement_timeout = '10s'
AS $$
DECLARE
  a jsonb;
  after jsonb;
  w inbox_bridge.worksets;
  cursor_row inbox_bridge.cursors;
  current_targets jsonb;
  page_limit integer;
  has_cursor boolean;
BEGIN
  IF scope_id IS NULL THEN
    RAISE EXCEPTION 'INBOX_SCOPE_INVALID' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO w FROM inbox_bridge.worksets WHERE id = scope_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INBOX_SCOPE_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;

  a := inbox_bridge.authorize_serving(w.org_id);
  IF w.user_id <> (a->>'user_id')::uuid
     OR w.session_id <> (a->>'session_id')::uuid
     OR w.access_epoch <> (a->>'access_epoch')::bigint
     OR w.revoked
     OR w.expires_at <= clock_timestamp()
     OR (a->>'expires_at')::timestamptz <= clock_timestamp() THEN
    RAISE EXCEPTION 'INBOX_SCOPE_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;

  IF NOT w.source_cursor_bound THEN
    RETURN jsonb_build_object(
      'has_updates', false,
      'refresh_required', true,
      'scope_id', w.id,
      'org_id', w.org_id,
      'requester_id', w.user_id,
      'session_id', w.session_id,
      'access_epoch', w.access_epoch::text,
      'generation', w.generation::text
    );
  END IF;

  has_cursor := w.source_cursor_id IS NOT NULL;
  IF has_cursor THEN
    SELECT c.* INTO cursor_row
      FROM inbox_bridge.cursors c
      JOIN inbox_bridge.worksets origin_scope ON origin_scope.id = c.scope_id
     WHERE c.id = w.source_cursor_id
       AND origin_scope.org_id = w.org_id
       AND origin_scope.user_id = w.user_id
       AND origin_scope.session_id = w.session_id
       AND origin_scope.access_epoch = w.access_epoch;
    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'has_updates', false,
        'refresh_required', true,
        'scope_id', w.id,
        'org_id', w.org_id,
        'requester_id', w.user_id,
        'session_id', w.session_id,
        'access_epoch', w.access_epoch::text,
        'generation', w.generation::text
      );
    END IF;
  END IF;

  page_limit := w.source_page_limit;
  IF page_limit IS NULL OR page_limit < 1 OR page_limit > 500 THEN
    RAISE EXCEPTION 'INBOX_SCOPE_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;

  SELECT coalesce(
           jsonb_agg(
             jsonb_build_object('kind', rows.target_kind, 'id', rows.target_id)
             ORDER BY rows.latest_at DESC NULLS LAST,
                      rows.target_kind, rows.target_id
           ),
           '[]'::jsonb
         )
    INTO current_targets
    FROM inbox_bridge.page(
      w.org_id,
      w.user_id,
      w.filter,
      CASE WHEN has_cursor THEN cursor_row.latest_at ELSE NULL END,
      CASE WHEN has_cursor THEN cursor_row.target_kind ELSE NULL END,
      CASE WHEN has_cursor THEN cursor_row.target_id ELSE NULL END,
      has_cursor,
      page_limit
    ) rows;

  -- Re-read identity after the bounded bridge.page call.  A revocation or
  -- epoch change that commits while the probe is running must invalidate the
  -- result instead of returning a late arrival signal for a stale scope.
  after := inbox_bridge.authorize_serving(w.org_id);
  IF after->>'user_id' IS DISTINCT FROM a->>'user_id'
     OR after->>'session_id' IS DISTINCT FROM a->>'session_id'
     OR after->>'org_id' IS DISTINCT FROM a->>'org_id'
     OR after->>'access_epoch' IS DISTINCT FROM a->>'access_epoch'
     OR (after->>'expires_at')::timestamptz <= clock_timestamp() THEN
    RAISE EXCEPTION 'INBOX_ACCESS_CHANGED' USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'has_updates', current_targets IS DISTINCT FROM w.targets,
    'refresh_required', false,
    'scope_id', w.id,
    'org_id', w.org_id,
    'requester_id', w.user_id,
    'session_id', w.session_id,
    'access_epoch', w.access_epoch::text,
    'generation', w.generation::text
  );
END;
$$;

CREATE FUNCTION public.inbox_probe_workset_updates(scope_id uuid)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '2s'
SET statement_timeout = '10s'
AS $$ SELECT inbox_bridge.probe_current_workset(scope_id) $$;

REVOKE ALL ON FUNCTION inbox_bridge.probe_current_workset(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.inbox_probe_workset_updates(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.inbox_probe_workset_updates(uuid) TO authenticated;
NOTIFY pgrst, 'reload schema';
COMMIT;
