# Inbound Auto-Promotion Backfill

One-off maintenance script for production properties that were promoted by the old inbound-SMS webhook from `prospect` to `new_lead`.

The script is dry-run by default. It only writes with `--apply`.

It requires production `NEXT_PUBLIC_SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The script refuses to run unless the Supabase project ref is `copflsklaefwzipsrjqz`.

## Commands

Dry run:

```bash
npx tsx scripts/backfill-inbound-auto-promoted-leads.ts
```

Apply after dry-run approval:

```bash
npx tsx scripts/backfill-inbound-auto-promoted-leads.ts --org-id <org-id> --apply
```

Undo an apply manifest:

```bash
npx tsx scripts/backfill-inbound-auto-promoted-leads.ts --org-id <org-id> --undo tmp/inbound-auto-promotion-backfill/backfill-<timestamp>.json
npx tsx scripts/backfill-inbound-auto-promoted-leads.ts --org-id <org-id> --undo tmp/inbound-auto-promotion-backfill/backfill-<timestamp>.json --apply
```

## Selection Rules

The script first queries production for all current `qualified_by` values and only includes known auto-promotion markers that actually exist in prod:

- `system:inbound_reply`
- `system:outbound_reply`

Rows are base candidates only when all of these are true:

- `status = 'new_lead'`
- `deleted_at IS NULL`
- `qualified_at IS NOT NULL`
- `qualified_by` is one of the included system markers
- `org_id` is in the `--org-id` allowlist when an org scope is supplied

Rows are excluded as human-touched when any of these happened after `qualified_at`:

- `outreach_dispo` is set
- `follow_up_at` is set
- a `lead_notes` row exists
- a `tasks` row exists
- an outbound message exists that is not an AI-responder message and is not linked to `sequence_step_runs`

By default, the script also excludes rows where `properties.updated_at` is more than five minutes after `qualified_at`. That is a conservative catch-all for silent property edits because this schema does not have a dedicated status/edit-history table. To report but not exclude that signal, run with:

```bash
npx tsx scripts/backfill-inbound-auto-promoted-leads.ts --ignore-updated-at-catchall
```

## Write Behavior

The apply path mirrors `revertToProspect()` in `src/app/(dashboard)/leads/actions.ts`:

- sets `status` to `prospect`
- clears `qualified_at`
- clears `qualified_by`
- stamps `updated_at`

Updates are grouped by `org_id` and update only the IDs selected by the dry-run logic. Re-running is idempotent because changed rows no longer match `status = 'new_lead'` or the system `qualified_by` marker.

Writes require at least one explicit `--org-id <uuid>` because the script uses a service-role client for maintenance and therefore does not rely on dashboard-user RLS. The flag can be repeated for a multi-org repair, and apply/undo refuses rows outside the allowlist.

Before each batch update, the script reloads the current property rows and related human-touch signals. If any row no longer matches the base query or has become human-touched, the run aborts before updating that batch. Each row update also guards on the reloaded `updated_at` value so a concurrent property edit causes a fail-closed abort instead of a stale write.

Before any update, the script writes a manifest under `tmp/inbound-auto-promotion-backfill/`. That folder is gitignored. The manifest stores changed IDs and the prior qualification fields for undo.
