import type {
  ChannelResult,
  DeliveryRow,
  DeliveryStore,
  EnsureInput,
  HoldAlertDeps,
  HoldInfo,
  Recipient,
} from "./types";

/** In-memory DeliveryStore with the same unique-key + atomic-claim semantics as the table. */
export class FakeStore implements DeliveryStore {
  rows: Array<DeliveryRow & { sentAt: string | null; orgId: string }> = [];
  private seq = 0;
  constructor(private readonly clock: () => Date) {}

  async ensure(input: EnsureInput): Promise<DeliveryRow> {
    const existing = this.rows.find(
      (r) =>
        r.holdKey === input.holdKey &&
        r.recipientUserId === input.recipientUserId &&
        r.channel === input.channel &&
        r.stage === input.stage,
    );
    if (existing) return { ...existing };
    const row = {
      id: `d${++this.seq}`,
      orgId: input.orgId,
      propertyId: input.propertyId,
      holdKey: input.holdKey,
      recipientUserId: input.recipientUserId,
      channel: input.channel,
      stage: input.stage,
      status: "pending" as const,
      attempts: 0,
      lastError: null,
      createdAt: this.clock().toISOString(),
      sentAt: null,
    };
    this.rows.push(row);
    return { ...row };
  }
  async claim(row: DeliveryRow): Promise<boolean> {
    const live = this.rows.find((r) => r.id === row.id);
    if (!live || (live.status !== "pending" && live.status !== "failed") || live.attempts !== row.attempts) {
      return false;
    }
    live.attempts += 1;
    return true;
  }
  async markSent(id: string) {
    const r = this.rows.find((x) => x.id === id)!;
    r.status = "sent";
    r.sentAt = this.clock().toISOString();
  }
  async markSkipped(id: string, reason: string) {
    const r = this.rows.find((x) => x.id === id)!;
    r.status = "skipped";
    r.lastError = reason;
  }
  async markFailed(id: string, error: string, terminal?: boolean) {
    const r = this.rows.find((x) => x.id === id)!;
    r.status = "failed";
    r.lastError = error;
    if (terminal) r.attempts = Math.max(r.attempts, 3);
  }
  async countSentSince(q: { orgId: string; channel: string; recipientUserId?: string; sinceIso: string }) {
    return this.rows.filter(
      (r) =>
        r.status === "sent" &&
        r.orgId === q.orgId &&
        r.channel === q.channel &&
        (!q.recipientUserId || r.recipientUserId === q.recipientUserId) &&
        r.sentAt !== null &&
        r.sentAt >= q.sinceIso,
    ).length;
  }
}

export const ORG = "org-1";
export const OWNER: Recipient = { userId: "owner-1", role: "owner" };
export const ACQ: Recipient = { userId: "acq-1", role: "member" };

export function hold(over: Partial<HoldInfo> = {}): HoldInfo {
  return {
    holdKey: "prop-1:2026-10-08T10:00:00.000Z",
    propertyId: "prop-1",
    since: "2026-10-08T10:00:00.000Z",
    name: "Dana",
    address: "12 Oak St, Kansas City",
    hot: false,
    ...over,
  };
}

export type Sent = { channel: "slack" | "sms" | "email"; userId: string; text: string };

export function makeDeps(
  over: Partial<HoldAlertDeps> & { holds?: HoldInfo[]; recipients?: Recipient[]; nowIso?: string } = {},
) {
  let nowIso = over.nowIso ?? "2026-10-08T10:02:00.000Z";
  const clock = () => new Date(nowIso);
  const store = (over.store as FakeStore | undefined) ?? new FakeStore(clock);
  const sent: Sent[] = [];
  const results: Record<"slack" | "sms" | "email", ChannelResult> = {
    slack: { status: "sent" },
    sms: { status: "sent" },
    email: { status: "sent" },
  };
  const deps: HoldAlertDeps = {
    now: clock,
    store,
    baseUrl: "https://app.example.com",
    emailEnabled: false,
    loadHolds: async () => over.holds ?? [hold()],
    loadRecipients: async () => over.recipients ?? [OWNER, ACQ],
    isRecipientAuthorized: async () => true,
    sendSlack: async (userId, text) => {
      sent.push({ channel: "slack", userId, text });
      return results.slack;
    },
    sendSms: async (userId, text) => {
      sent.push({ channel: "sms", userId, text });
      return results.sms;
    },
    sendEmail: async (userId, message) => {
      sent.push({ channel: "email", userId, text: `${message.subject}\n${message.text}` });
      return results.email;
    },
    ...over,
  };
  return {
    deps,
    store: store as FakeStore,
    sent,
    results,
    setNow: (iso: string) => {
      nowIso = iso;
    },
  };
}
