/**
 * Routing v2 PR-A: the inline webhook's entry to the record-only shadow. Kept out of
 * `messaging/inbound.ts` imports of `sms-classification` (keyword gates stay ahead of
 * Jev; see keyword-gates-before-jev.test.ts). Called only after the terminal stamp.
 */
export { scheduleRoutingV2Shadow } from "@/lib/sms-classification/routing-v2/shadow";
