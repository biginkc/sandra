-- Enforce the operator rule across all sequences, including paused drips.
-- Historical completed and opted-out enrollments remain available for attribution.
create unique index if not exists idx_enrollments_one_live_per_property
  on public.sequence_enrollments (property_id)
  where status in ('active', 'paused');
