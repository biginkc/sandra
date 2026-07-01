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

export type ProviderSenderNumber = {
  /** E.164 number the account owns and can send from. */
  phoneE164: string;
  /** Provider's stable id for the number, when it exposes one. */
  providerNumberId: string | null;
  /** Provider-reported status string, verbatim (e.g. "active"). */
  status: string | null;
  /** Provider-reported messaging/10DLC status, when exposed. */
  messagingStatus: string | null;
  /** Raw catalog entry — stored in provider_sender_numbers.raw for audit. */
  raw: unknown;
};

export type ProviderCampaignSummary = {
  /** Provider's stable id — the upsert key for the synced catalog. */
  externalId: string;
  name: string | null;
  brand: string | null;
  useCase: string | null;
  /** Provider-reported status string, verbatim. */
  status: string | null;
  /** Raw catalog entry — stored in provider_campaigns.raw for audit. */
  raw: unknown;
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

export type SmsStatusEvent = {
  kind: "sent" | "delivered" | "failed";
  externalId: string;
  timestamp: Date;
  errorMessage?: string;
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

  /**
   * Provider-configured default sender, when one exists. Used for
   * persisting outbound breadcrumbs before the provider call happens.
   */
  getDefaultFromNumber?(): string | null;

  sendSms(input: SmsOutboundInput): Promise<SmsSendResult>;

  /**
   * Return `true` when the webhook is authentic. Caller passes the
   * exact raw body bytes (not parsed JSON), the full request headers,
   * and (optionally) the full request URL — Twilio's signature scheme
   * folds the URL into the canonical string, while DialPad's JWT
   * scheme ignores it.
   */
  verifyWebhookSignature(
    rawBody: string,
    headers: Headers,
    fullUrl?: string,
  ): boolean;

  /** Decode a raw webhook payload into zero-or-more inbound events.
   *  Providers batch multiple events per delivery; we flatten here. */
  parseInboundWebhook(rawBody: string): SmsInboundEvent[];

  /** Decode raw delivery-status webhooks into normalized message events. */
  parseStatusWebhook?(rawBody: string): SmsStatusEvent[];

  /**
   * List the phone numbers on the account with resolved owner names, so
   * the UI can render a "send from" picker instead of hard-coding the
   * number in an env var. Optional because not every provider exposes
   * a numbers-list endpoint; callers that need it should handle a
   * possible empty array gracefully.
   */
  listFromNumbers?(): Promise<DialpadFromOption[]>;

  /**
   * Read-only catalog: the sender numbers the provider account has
   * purchased/owns. Synced into provider_sender_numbers so campaign
   * Delivery setup can offer them and the release guard can validate
   * queued rows against approved inventory. Presence of this method is
   * also the signal that the provider participates in sender-inventory
   * validation at release time.
   */
  listPurchasedNumbers?(): Promise<ProviderSenderNumber[]>;

  /**
   * Read-only catalog: provider-side campaigns (10DLC/brand context).
   * Optional metadata only — Sandra campaigns never depend on these.
   */
  listProviderCampaigns?(): Promise<ProviderCampaignSummary[]>;
}
