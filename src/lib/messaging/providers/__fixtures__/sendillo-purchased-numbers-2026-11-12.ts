/**
 * Sendillo GET /api/v1/numbers/purchased, observed live 2026-11-12 07:39 UTC
 * while a number-addition request was pending on the BMH campaign (campaign 62
 * status "PENDING NUMBER ADDITION"). Field values verbatim; phones come back
 * without a leading "+". Only the fields Sandra reads are kept.
 */
export const SENDILLO_PURCHASED_PENDING_ADDITION_2026_11_12 = [
  {
    phoneNumber: "18164876899",
    numberStatus: "Active",
    messagingStatus: "Inactive",
    attachedBrand: "BMH Group",
    attachedCampaign: "Kansas City Metro SMS Outreach",
  },
  {
    phoneNumber: "18164876883",
    numberStatus: "Active",
    messagingStatus: "Inactive",
    attachedBrand: "not assigned",
    attachedCampaign: "not assigned",
  },
] as const;
