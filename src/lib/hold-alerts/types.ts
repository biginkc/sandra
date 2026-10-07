export type AlertChannel = "slack" | "sms" | "email";
export type AlertStage = "first" | "nudge_1h" | "digest";
export type DeliveryStatus = "pending" | "sending" | "sent" | "failed" | "skipped";

/** A hold reduced to what an alert may carry: ids, first name, age. Never message text or address. */
export type HoldInfo = {
  /**
   * `${property_id}:${reason key}`. Deliberately NOT keyed on the hold's start
   * time: that moves whenever the oldest underlying item resolves, which would
   * re-alert a hold nobody touched. Recipient, channel and stage complete the
   * unique key in hold_alert_deliveries.
   */
  holdKey: string;
  propertyId: string;
  since: string | null;
  /** When the hold began (oldest reliable start); null = unknown (backlog), which never alerts. */
  startedAt: string | null;
  /** First name (or "Unknown ···1234"), from the page's label loader. */
  name: string;
  /** One of the hold's reasons is in the configured hot list (HOLD_ALERT_HOT_REASONS, exact match). */
  hot: boolean;
};

export type Recipient = { userId: string; role: "owner" | "member" };

export type DeliveryRow = {
  id: string;
  orgId: string;
  propertyId: string | null;
  holdKey: string;
  recipientUserId: string;
  channel: AlertChannel;
  stage: AlertStage;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
};

export type EnsureInput = {
  orgId: string;
  propertyId: string | null;
  holdKey: string;
  recipientUserId: string;
  channel: AlertChannel;
  stage: AlertStage;
};

export type ChannelResult =
  | { status: "sent" }
  | { status: "skipped"; reason: string }
  /** `terminal`: delivery is ambiguous (may have been transmitted); never retry. */
  | { status: "failed"; error: string; terminal?: boolean };

export interface DeliveryStore {
  /**
   * The org's alert watermark. Inserts `alerts_since = nowIso` when the org has
   * none (insert ... on conflict do nothing) and reports `created: true` for the
   * run that inserted it; that run sends nothing.
   */
  getOrInitAlertsSince(orgId: string, nowIso: string): Promise<{ alertsSince: string; created: boolean }>;
  /** insert ... on conflict do nothing, then return the row for the unique key. */
  ensure(input: EnsureInput): Promise<DeliveryRow>;
  /**
   * Atomic claim: update ... set status = 'sending', sending_at = now(),
   * attempts = attempts + 1 where id = row.id and status in ('pending','failed')
   * and attempts = row.attempts. The row is 'sending' BEFORE the provider call,
   * so a crash leaves a row that is never resent. False when another run got
   * there first or the row is no longer claimable.
   */
  claim(row: DeliveryRow): Promise<boolean>;
  /**
   * Rows stuck in 'sending' since before `cutoffIso` (the run died mid-send)
   * become terminal failed:interrupted. They are never resent: the provider may
   * already have delivered. Returns how many were swept.
   */
  failInterrupted(cutoffIso: string): Promise<number>;
  /** When the SENT delivery for this (hold, recipient, channel, stage) went out; null when there is none. */
  sentAt(q: { holdKey: string; recipientUserId: string; channel: AlertChannel; stage: AlertStage }): Promise<string | null>;
  /**
   * Archive-on-clear. Delivery rows (per-hold, so property_id is set) whose
   * property is not in `openPropertyIds` get `hold_key = hold_key || ':closed:' || id`
   * so a hold that re-opens later is a new key and alerts again. One guarded
   * update per row (idempotent, safe to crash and repeat). Digest rows
   * (property_id null) and already-archived rows are never touched. Returns the
   * number archived.
   */
  archiveClosed(orgId: string, openPropertyIds: readonly string[]): Promise<number>;
  markSent(id: string): Promise<void>;
  markSkipped(id: string, reason: string): Promise<void>;
  /** attempts was already incremented by claim(); `terminal` pins attempts at the max. */
  markFailed(id: string, error: string, terminal?: boolean): Promise<void>;
  countSentSince(q: {
    orgId: string;
    channel: AlertChannel;
    recipientUserId?: string;
    sinceIso: string;
  }): Promise<number>;
}

export type EmailMessage = { subject: string; text: string };

export interface HoldAlertDeps {
  now(): Date;
  store: DeliveryStore;
  /** App base URL without trailing slash. */
  baseUrl: string;
  /** HOLD_ALERT_EMAIL_ENABLED === "1". When false no digest rows are created. */
  emailEnabled: boolean;
  /**
   * Alertable holds only (property known, informational holds removed).
   * `complete` is false when the underlying hold queries were truncated or
   * failed: an incomplete set must never be used to decide a hold has closed.
   */
  loadHolds(orgId: string): Promise<{ holds: HoldInfo[]; complete: boolean }>;
  /** Active owner + acquisitions members. */
  loadRecipients(orgId: string): Promise<Recipient[]>;
  /**
   * Re-reads the membership right before each send. `requireOwner` also
   * re-confirms role = owner at send time (the SMS path).
   */
  isRecipientAuthorized(orgId: string, userId: string, opts?: { requireOwner?: boolean }): Promise<boolean>;
  sendSlack(userId: string, text: string): Promise<ChannelResult>;
  sendSms(userId: string, text: string): Promise<ChannelResult>;
  sendEmail(userId: string, message: EmailMessage, opts?: { idempotencyKey?: string }): Promise<ChannelResult>;
}

export type OrgAlertSummary = {
  holds: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Rows already sent/skipped/exhausted, or claimed by a concurrent run. */
  untouched: number;
  /** Over a cap: left pending for the next run, not skipped. */
  deferred: number;
  /** Rows swept from 'sending' to failed:interrupted (a previous run died mid-send). */
  interrupted: number;
  /** Delivery rows archived because their hold closed (a re-open alerts again). */
  archived: number;
  /** Ran out of the time budget; remaining rows are picked up next run. */
  budgetExhausted: boolean;
};

/**
 * The alert route's maxDuration, in ms (keep equal to `maxDuration` in
 * src/app/api/cron/hold-alerts/route.ts; a test enforces it). A delivery still
 * 'sending' after this long belongs to a run that no longer exists.
 */
export const ROUTE_MAX_DURATION_MS = 60_000;

/** A delivery is retried while failed with fewer attempts than this. */
export const MAX_ATTEMPTS = 3;
