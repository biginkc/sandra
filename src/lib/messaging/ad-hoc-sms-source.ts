/**
 * `campaigns.audience_snapshot.source` stamped on ad-hoc bulk-SMS campaigns at creation
 * (src/lib/campaigns/ad-hoc-bulk-sms.ts) and read back by the legacy bulk-sms workflow to derive
 * provenance (src/workflows/bulk-sms.ts `campaignSourceFromRecord`). Main exports no shared
 * constant and changing those legacy files is off limits for Search, so this is a LOCAL copy,
 * pinned to main's literals by ad-hoc-sms-source.test.ts.
 */
export const AD_HOC_BULK_SMS_SOURCE = "bulk_sms_modal";
