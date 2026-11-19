import type { VoicemailDropReasonInfo } from "./types";

/**
 * Drop Cowboy reason codes, classified from the official Outcomes page
 * (https://www.dropcowboy.com/developers/api/outcomes). Anything not listed is
 * "unclassified".
 */
const CONFIG_CODES = new Set([
  3000, // No Funds
  3001, // Audio file not valid
  3002, // No Voice
  3007, // Not authorized
  3013, // Invalid IVR or Route (phone line)
  3015, // No TTS
  3021, // TTS too long
  3023, // US Identity Verification Required
  3027, // Idempotency Key Conflict
  3028, // Invalid Idempotency Key
  3040, // Test Numbers Only
  4010, // No Caller ID (phone line)
  5000, // Account Inactive
  5001, // Payment Required
  6009, // Unregistered Brand
]);
const CONSENT_CODES = new Set([
  4016, // Internal DNC
  4017, // Known Litigator
  6005, // Opt-in Revoked
  6011, // Opt-in Missing
]);
const DELIVERY_CODES = new Set([
  4000, // VoiceMail Not Detected (transient)
  4001, // VoiceMail Not Setup
  4002, // VoiceMail Full
  4003, // Temporarily unreachable (transient)
  4004, // Number not reachable (transient)
  4005, // No Answer (transient)
  4006, // User Busy (transient)
  4007, // Not Mobile
  4008, // Spam detected (transient)
  4009, // Public Safety Number
  4019, // RND Reassigned
]);
const FREQUENCY_CODES = new Set([
  4013, // Too Many Attempts (contact frequency limit)
]);

export function classifyReasonCode(code: number | null | undefined): VoicemailDropReasonInfo {
  const reasonCode = typeof code === "number" && Number.isInteger(code) ? code : null;
  if (reasonCode === 0) return { reasonCode, reasonClass: "success" };
  if (reasonCode === null) return { reasonCode, reasonClass: "unclassified" };
  if (CONFIG_CODES.has(reasonCode)) return { reasonCode, reasonClass: "config" };
  if (CONSENT_CODES.has(reasonCode)) return { reasonCode, reasonClass: "consent" };
  if (DELIVERY_CODES.has(reasonCode)) return { reasonCode, reasonClass: "delivery" };
  if (FREQUENCY_CODES.has(reasonCode)) return { reasonCode, reasonClass: "frequency" };
  return { reasonCode, reasonClass: "unclassified" };
}
