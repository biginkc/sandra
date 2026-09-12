# My Leads query and scope review

Review target: `8c7053e7` plus the current dirty worktree changes, limited to the
read model, KPI, roster, detail SQL, and their server query/action boundaries:

- `supabase/migrations/20260912110000_acquisition_read_model.sql`
- `supabase/migrations/20260912111000_acquisition_kpis.sql`
- `supabase/migrations/20260912112000_acquisition_roster.sql`
- `supabase/migrations/20260912113000_acquisition_detail.sql`
- `src/lib/my-leads/queries.ts`
- `src/app/(dashboard)/my-leads/actions.ts`

This is a static review. No shared or hosted database, provider, browser, or
runtime was used. The worktree is dirty and the four migration files and My
Leads UI/query files are uncommitted; line anchors below refer to the current
working tree and should be rechecked after integration.

## Findings and resolutions

### [P1, resolved] Detail RPC could return a DNC property after it left the queue

The initial review found `fn_get_acquisition_detail` authorizing a property
only by organization, current assignee, and `deleted_at`. The queue projection
already applied the active-row filter at
`20260912110000_acquisition_read_model.sql:71-72`, and the existing permanent
DNC board also excludes locked properties
(`20260815190000_true_dnc_property_lock.sql:569-605`).

The current dirty worktree adds `and not is_dnc_locked` to the detail
authorization at `20260912113000_acquisition_detail.sql:34`. A direct detail
request now fails before `my_leads_detail_rows` for a locked property. The
current-assignment guard remains appropriate: KPI/episode history does not
grant unrestricted current detail access after reassignment.

### [P2, resolved] Appointment detail reported mutable current assignee as actor

The initial review found the appointments branch using mutable
`tasks.assignee_id`. The current dirty worktree now emits immutable
`actorId` from `acquisition_appointment_attribution.accountable_user_id` and
separate `currentAssigneeId` at
`20260912113000_acquisition_detail.sql:14-19`, matching KPI attribution while
preserving current-assignee lifecycle authorization.

### [P2, resolved] Queue search omitted the property ZIP

The queue search text now includes `w.zip` with the street address, city, state,
name, and phones at `20260912110000_acquisition_read_model.sql:86`. This makes
postal-code lookup part of ordinary address search without changing row scope
or ranking.

## Areas reviewed with no additional material finding

- **Queue authorization and paging:** `my_leads_require_read_scope` checks an
  active viewer membership, the organization feature gate, and selected-member
  self/owner/designation/history authority (`20260912110000_acquisition_read_model.sql:19-37`).
  The page RPC validates cursor organization, viewer, selected member, stage,
  normalized search, and expiry (`:115-126`), issues bounded pages, and uses a
  shared snapshot timestamp. The server wrapper also prevents a member from
  selecting a different member (`src/lib/my-leads/queries.ts:57-62`).
- **KPI attribution and periods:** attempts and offers use original actor and
  event time; first-call samples use eligible live episodes beginning in the
  requested half-open period; appointment due/held counts use immutable
  booking-time attribution and exclude rescheduled predecessors
  (`20260912111000_acquisition_kpis.sql:39-58`). The wrapper supplies Central
  time half-open bounds (`src/lib/my-leads/queries.ts:64-73`).
- **Roster scope:** the roster RPC requires an active same-org viewer and only
  exposes all same-org memberships to an owner; a member receives its own row
  (`20260912112000_acquisition_roster.sql:9-24`). Designation/history selection
  remains separate from Sandra access roles, as required by the PRD.
- **Current-member detail boundary:** the owner/member query wrappers and SQL
  require the property to remain assigned to the selected member
  (`src/lib/my-leads/queries.ts:85-90` and
  `20260912113000_acquisition_detail.sql:32-35`). This is consistent with
  selected active queue inspection; historical KPI/episode attribution does
  not imply unrestricted access to every reassigned property's current notes.
- **Server action boundary:** queue/KPI/detail actions resolve the authenticated
  viewer through `myLeadsViewer`, and detail/call-reference RPCs still enforce
  selected-member/property scope in SQL (`src/app/(dashboard)/my-leads/actions.ts:9-21,51-57`).
  No direct table reads were found in these action paths.

## Limits

This review did not execute SQL or inspect live deployed schema/data. It did not
re-audit assignment observer, workflow, call evidence, launch, or mutation SQL.
Appointment attribution correctness is assumed from its reviewed trigger and
sidecar contract; historical rows without immutable attribution remain an
unavailable-data concern rather than a query authorization finding.
