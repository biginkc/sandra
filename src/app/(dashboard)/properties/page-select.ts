/**
 * The Search page's row select (property columns plus the homeowner embed). Shared with the
 * evaluation-budget and volume suites so they measure the page's real request shape.
 */
export const PAGE_PROPERTIES_SELECT =
  "id, org_id, address, city, state, zip, market, cass_status, is_vacant, created_at, status, is_dnc_locked, outreach_dispo, source_import_id, source_imported_at, homeowner:contacts!properties_homeowner_contact_id_fkey(phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)";
