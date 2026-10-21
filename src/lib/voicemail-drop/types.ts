/**
 * Voicemail drop provider layer (plan: .planning/voicemail-drop-step-plan.md,
 * build-order step 2). Provider-neutral types; the Drop Cowboy adapter and the
 * mock live under ./providers.
 */

export type VoicemailDropAudio =
  | { kind: "tts"; ttsBody: string; voiceId: string }
  | { kind: "media"; mediaId: string };

export type VoicemailDropSendInput = {
  /** Sent as the Idempotency-Key header. The worker passes step_run_id. */
  idempotencyKey: string;
  /** E.164 recipient number. */
  to: string;
  audio: VoicemailDropAudio;
  phoneLineId: string;
  /** voicemail_drops.id, echoed back on callback_url. */
  foreignId: string;
  callbackUrl: string;
  /** The plan always sends true. */
  mobileOnly: boolean;
  /** The plan always sends 1. */
  maxAttempts: number;
  postalCode?: string | null;
};

/**
 * Outcome of one send attempt (RULING RVM-4). The worker maps these to step
 * run state; nothing here retries.
 *
 * - accepted: 202, queued. Not a delivery; the outcome arrives later.
 * - not_queued: 429 / 500, nothing sent. Safe to retry next tick.
 * - unknown: 502 SendQueueNoReceipt, timeout, network error, or any
 *   unexpected status. May have been queued. Never blind-retry.
 * - bad_request: 400, an adapter bug. Nothing sent.
 * - unauthorized: 401, missing credentials. Nothing sent.
 */
export type VoicemailDropSendResult =
  | { outcome: "accepted"; httpStatus: 202; messageId: string | null; raw: unknown }
  | { outcome: "not_queued"; httpStatus: 429 | 500; raw: unknown }
  | {
      outcome: "unknown";
      httpStatus: number | null;
      cause: "no_receipt" | "timeout" | "network" | "unexpected_status";
      error?: string;
      raw: unknown;
    }
  | { outcome: "bad_request"; httpStatus: 400; detail: string | null; raw: unknown }
  | { outcome: "unauthorized"; httpStatus: 401; detail: string | null; raw: unknown };

export type VoicemailDropReasonClass =
  | "success"
  | "config"
  | "consent"
  | "delivery"
  | "unclassified";

export type VoicemailDropReasonInfo = {
  reasonCode: number | null;
  reasonClass: VoicemailDropReasonClass;
  /** True for codes the plan marks as not in the saved spec (6005, 6011). */
  unverified: boolean;
};

/** Body POSTed to callback_url (SendOutcome). Unsigned. */
export type VoicemailDropCallbackEvent = {
  kind: "callback";
  foreignId: string | null;
  dropId: string | null;
  status: "success" | "failure";
  reason: string | null;
  reasonCode: number | null;
  reasonClass: VoicemailDropReasonClass;
  reasonUnverified: boolean;
  phoneNumber: string | null;
  productCode: string | null;
  proofUrl: string | null;
  /** product_cost + compliance_fee + tts_fee when any are present. */
  cost: number | null;
  attemptDate: string | null;
  raw: Record<string, unknown>;
};

/** Signed contact.rvm.status / contact.rvm.receipt webhook. */
export type VoicemailDropStatusEvent = {
  kind: "status" | "receipt";
  eventId: string;
  eventAt: number | null;
  dropId: string | null;
  to: string | null;
  contactId: string | null;
  campaignType: string | null;
  status: "success" | "failure";
  reason: string | null;
  reasonCode: number | null;
  reasonClass: VoicemailDropReasonClass;
  reasonUnverified: boolean;
  proofUrl: string | null;
  receiptReadyAt: string | null;
  raw: Record<string, unknown>;
};

export type WebhookHeaders = Headers | Record<string, string | string[] | undefined>;

export type VoicemailDropSignatureCheck =
  | { valid: true }
  | { valid: false; reason: "missing_headers" | "bad_format" | "stale" | "mismatch" };

export interface VoicemailDropProvider {
  readonly id: "dropcowboy" | "mock";
  sendDrop(input: VoicemailDropSendInput): Promise<VoicemailDropSendResult>;
  verifyWebhookSignature(
    rawBody: string,
    headers: WebhookHeaders,
    nowMs?: number,
  ): VoicemailDropSignatureCheck;
  /** Throws on a body that is not a contact.rvm.status / receipt event. */
  parseStatusWebhook(rawBody: string): VoicemailDropStatusEvent;
  /** Throws on a body that is not a SendOutcome object. */
  parseCallback(rawBody: string): VoicemailDropCallbackEvent;
}
