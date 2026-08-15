/**
 * Provider prices already used by Sandra's production adapters. Keep this
 * module browser-safe so confirmation UIs never import provider clients.
 */
// Existing CASS surfaces historically used this planning assumption. It is
// intentionally NOT sufficient to enable a new paid import service because
// Smarty's public pricing is account/volume specific and Sandra has no
// verified account rate in configuration yet.
export const CASS_COST_PER_LOOKUP_USD = 0.03;
export const IMPORT_CASS_VERIFIED_COST_USD: number | null = null;

// Telnyx carrier lookup can incur the LRN dip ($0.0015) plus the mobile
// MCC/MNC lookup ($0.0025), so $0.004 is the safe pay-as-you-go maximum per
// number. Official pricing: https://telnyx.com/pricing/number-lookup
export const TELNYX_LOOKUP_COST_USD = 0.004;
