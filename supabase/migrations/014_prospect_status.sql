-- ============================================================================
-- Feature 4a+4b — Prospects/Leads split (migration 014)
--
-- Jarrad's architectural insight: not every record in the database is a
-- lead. Most are passive *prospects* — data sitting there from CSV imports,
-- never contacted. A record only becomes a lead after qualification
-- (someone talked to the seller, or the seller replied).
--
-- So /properties becomes the data lake (status='prospect'), /leads kanban
-- becomes the working surface (everything else). Promotion happens on
-- first inbound reply (auto) or a manual Qualify action.
-- ============================================================================

-- Add 'prospect' to the status check constraint. Order reflects the
-- pipeline: prospect → new_lead → contacted → ... → closed / dead.
alter table properties drop constraint properties_status_check;

alter table properties add constraint properties_status_check
  check (status in (
    'prospect',
    'new_lead',
    'contacted',
    'interested',
    'offer_sent',
    'offer_declined',
    'under_contract',
    'closed',
    'dead'
  ));

-- Qualification stamps. `qualified_by` is text (not uuid) so it can hold
-- either a user id (manual qualify) or a system marker like
-- 'system:inbound_reply' / 'system:outbound_reply' (auto-qualify).
alter table properties add column qualified_at timestamptz;
alter table properties add column qualified_by text;

-- Backfill: any row currently at 'new_lead' with NO messaging activity
-- was imported but never worked — treat it as a prospect retroactively.
-- Rows with any inbound or outbound message stay where they are (they've
-- been touched, so they're legitimately in the pipeline already).
update properties p
set status = 'prospect'
where p.status = 'new_lead'
  and not exists (
    select 1 from messages m where m.property_id = p.id
  );
