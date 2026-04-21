-- Replace `researching` with `offer_declined` in the properties.status enum.
-- Decision 2026-04-21: the original enum conflated deal-stage with offer-stage
-- and included `researching` which didn't map to BMH's actual workflow.
-- Risk #7 (deal-stage vs offer-stage table split) stays deferred; for now we
-- keep the flat status field but use the values Jarrad actually works in.

alter table properties drop constraint properties_status_check;

alter table properties add constraint properties_status_check
  check (status in (
    'new_lead',
    'contacted',
    'interested',
    'offer_sent',
    'offer_declined',
    'under_contract',
    'closed',
    'dead'
  ));
