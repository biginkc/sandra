export type AlertChannel = "slack" | "sms" | "email";
export type AlertStage = "first" | "nudge_1h" | "digest";
export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";

/** A hold reduced to what an alert may carry: ids, first name, address, age. Never message text. */
export type HoldInfo = {
  /** `${property_id}:${since ?? "unknown"}`: a hold that clears and re-opens alerts again. */
  holdKey: string;
  propertyId: string;
  since: string | null;
  /** First name (or "Unknown ···1234"), from the page's label loader. */
  name: string;
  address: string | null;
  /** Hold text contains a HOT_HOLD_REASON_TOKENS token. */
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
  /** insert ... on conflict do nothing, then return the row for the unique key. */
  ensure(input: EnsureInput): Promise<DeliveryRow>;
  /**
   * Atomic claim: update ... set attempts = attempts + 1 where id = row.id and
   * status in ('pending','failed') and attempts = row.attempts. False when
   * another run got there first or the row is no longer claimable.
   */
  claim(row: DeliveryRow): Promise<boolean>;
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
  /** Alertable holds only (property known, informational holds removed). */
  loadHolds(orgId: string): Promise<HoldInfo[]>;
  /** Active owner + acquisitions members. */
  loadRecipients(orgId: string): Promise<Recipient[]>;
  /** Re-reads the membership right before each send. */
  isRecipientAuthorized(orgId: string, userId: string): Promise<boolean>;
  sendSlack(userId: string, text: string): Promise<ChannelResult>;
  sendSms(userId: string, text: string): Promise<ChannelResult>;
  sendEmail(userId: string, message: EmailMessage): Promise<ChannelResult>;
}

export type OrgAlertSummary = {
  holds: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Rows already sent/skipped/exhausted, or claimed by a concurrent run. */
  untouched: number;
  /** Ran out of the time budget; remaining rows are picked up next run. */
  budgetExhausted: boolean;
};

/** A delivery is retried while failed with fewer attempts than this. */
export const MAX_ATTEMPTS = 3;
