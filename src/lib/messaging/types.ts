/**
 * Cross-vendor messaging shapes. Adapters parse provider-specific payloads
 * into these and the rest of the app never sees vendor jargon. Same pattern
 * as `AddressVerifier` in `src/lib/enrichment/types.ts` — swapping Dialpad
 * for Twilio is one adapter file, not a rewrite.
 */

export type SmsOutboundInput = {
  /** E.164, e.g. "+18165551234". */
  to: string;
  body: string;
  /** Overrides the provider's default `from` number (env-configured). */
  from?: string;
};

export type SmsSendResult = {
  /** Provider-assigned message id. Stored in `messages.external_id` for
   *  idempotency + delivery-status reconciliation. */
  externalId: string;
  /** Raw provider status string — e.g. "queued" / "sent" / "delivered".
   *  Normalized by the caller to our messages.status enum. */
  providerStatus: string;
  /** Raw response — stored in `messages.metadata` for audit. */
  raw: unknown;
};

export type DialpadFromOption = {
  /** E.164 number (e.g. "+18163706846"). */
  number: string;
  /** Display name for the owner — "Jarrad Henry", "Main Office", or
   *  "(unassigned)" when no target. */
  ownerName: string;
  /** Kind of owner: "user" / "office" / "available" / other. */
  ownerType: string;
  /** Dialpad-reported status — "user" / "office" / "available" / ... */
  status: string;
};

export type SmsInboundEvent = {
  /** Provider message id — unique across retries. Paired with provider +
   *  event_type to form the idempotency key in `webhook_events`. */
  externalId: string;
  /** E.164. */
  from: string;
  /** E.164. */
  to: string;
  body: string;
  receivedAt: Date;
  /** Provider URLs for MMS attachments. Most providers expire these in
   *  24h or less — Phase 3 will fetch + store in Supabase Storage. For
   *  now the shape is reserved and consumers can persist the URL for
   *  audit but shouldn't rely on long-term access. */
  mediaUrls?: string[];
  /** Raw webhook payload — stored in `webhook_events.payload`. */
  raw: unknown;
};

/**
 * Common interface every SMS adapter implements. Matches the
 * `AddressVerifier` shape. `verifyWebhookSignature` lives on the adapter
 * because the scheme (which header, which hash, canonical body form)
 * varies per provider.
 */
export interface MessagingProvider {
  /** Identifier written to `messages.provider` + `webhook_events.provider`. */
  readonly providerId: string;

  sendSms(input: SmsOutboundInput): Promise<SmsSendResult>;

  /**
   * Return `true` when the webhook is authentic. Caller passes the
   * exact raw body bytes (not parsed JSON) and the full request headers.
   */
  verifyWebhookSignature(rawBody: string, headers: Headers): boolean;

  /** Decode a raw webhook payload into zero-or-more inbound events.
   *  Providers batch multiple events per delivery; we flatten here. */
  parseInboundWebhook(rawBody: string): SmsInboundEvent[];

  /**
   * List the phone numbers on the account with resolved owner names, so
   * the UI can render a "send from" picker instead of hard-coding the
   * number in an env var. Optional because not every provider exposes
   * a numbers-list endpoint; callers that need it should handle a
   * possible empty array gracefully.
   */
  listFromNumbers?(): Promise<DialpadFromOption[]>;
}
