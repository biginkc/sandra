const target = {
  propertyId: "synthetic-lead",
  contactId: "synthetic-contact",
  phoneE164: "+18165550101",
  maskedPhone: "(816) 555-0101",
  name: "Synthetic Homeowner",
  address: "100 Test Avenue",
  state: "MO",
  startedAt: "2026-08-29T20:00:00.000Z",
  repName: "Synthetic Coach",
};

export const loadDialerRecents = async () => ({ ok: true as const, data: [] });
export const searchDialerLeads = async () => ({ ok: true as const, data: [] });
export const prepareLeadCall = async () => ({ ok: true as const, data: target });
export const prepareManualCall = prepareLeadCall;
export const completeSoftphoneCall = async () => ({ ok: true as const, data: {} });
export const resumeFailedSoftphoneCall = async () => ({ ok: true as const, data: {} });
