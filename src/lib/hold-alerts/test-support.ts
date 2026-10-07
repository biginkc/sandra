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
  rows: Array<DeliveryRow & { sentAt: string | null; sendingAt?: string | null; orgId: string }> = [];
  private seq = 0;
  /** Per-org watermark; pre-seed (`watermarks.set(org, iso)`) to simulate an already-initialised org. */
  watermarks = new Map<string, string>();
  constructor(private readonly clock: () => Date) {}

  async getOrInitAlertsSince(orgId: string, nowIso: string) {
    const existing = this.watermarks.get(orgId);
    if (existing) return { alertsSince: existing, created: false };
    this.watermarks.set(orgId, nowIso);
    return { alertsSince: nowIso, created: true };
  }

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
    live.status = "sending";
    live.sendingAt = this.clock().toISOString();
    return true;
  }
  async failInterrupted(cutoffIso: string) {
    const stuck = this.rows.filter((r) => r.status === "sending" && r.sendingAt != null && r.sendingAt < cutoffIso);
    for (const r of stuck) {
      r.status = "failed";
      r.attempts = 3;
      r.lastError = "interrupted";
    }
    return stuck.length;
  }
  async sentAt(q: { holdKey: string; recipientUserId: string; channel: string; stage: string }) {
    return (
      this.rows.find(
        (r) =>
          r.status === "sent" &&
          r.holdKey === q.holdKey &&
          r.recipientUserId === q.recipientUserId &&
          r.channel === q.channel &&
          r.stage === q.stage,
      )?.sentAt ?? null
    );
  }
  async archiveClosed(orgId: string, openPropertyIds: readonly string[], candidatePropertyIds?: readonly string[]) {
    const open = new Set(openPropertyIds);
    const candidates = candidatePropertyIds ? new Set(candidatePropertyIds) : null;
    let n = 0;
    for (const r of this.rows) {
      if (r.orgId !== orgId || !r.propertyId || open.has(r.propertyId) || (candidates && !candidates.has(r.propertyId)) || r.holdKey.includes(":closed:")) continue;
      r.holdKey = `${r.holdKey}:closed:${r.id}`;
      n += 1;
    }
    return n;
  }
  async deliveredPropertyIds(orgId: string) {
    const ids = new Set<string>();
    for (const r of this.rows) {
      if (r.orgId === orgId && r.propertyId && !r.holdKey.includes(":closed:")) ids.add(r.propertyId);
    }
    return { ids: [...ids], complete: true };
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
        r.orgId === q.orgId &&
        r.channel === q.channel &&
        (!q.recipientUserId || r.recipientUserId === q.recipientUserId) &&
        ((r.status === "sent" && r.sentAt !== null && r.sentAt >= q.sinceIso) ||
          (r.status === "sending" && r.sendingAt != null && r.sendingAt >= q.sinceIso)),
    ).length;
  }
}

export const ORG = "org-1";
export const OWNER: Recipient = { userId: "owner-1", role: "owner" };
export const ACQ: Recipient = { userId: "acq-1", role: "member" };

export function hold(over: Partial<HoldInfo> = {}): HoldInfo {
  return {
    holdKey: "prop-1:draft_held",
    propertyId: "prop-1",
    since: "2026-10-08T10:00:00.000Z",
    startedAt: "2026-10-08T10:00:00.000Z",
    name: "Dana",
    hot: false,
    ...over,
  };
}

export type Sent = { channel: "slack" | "sms" | "email"; userId: string; text: string; idempotencyKey?: string };

export function makeDeps(
  over: Partial<HoldAlertDeps> & { holds?: HoldInfo[]; holdsComplete?: boolean; recipients?: Recipient[]; nowIso?: string; noWatermark?: boolean } = {},
) {
  let nowIso = over.nowIso ?? "2026-10-08T10:02:00.000Z";
  const clock = () => new Date(nowIso);
  const store = (over.store as FakeStore | undefined) ?? new FakeStore(clock);
  // Existing tests model an org whose alerts were enabled long ago; watermark tests clear this.
  if (!over.noWatermark && store instanceof FakeStore && !store.watermarks.has(ORG)) store.watermarks.set(ORG, "2026-10-01T00:00:00.000Z");
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
    loadHolds: async () => ({ holds: over.holds ?? [hold()], complete: over.holdsComplete ?? true }),
    // Default: a property is held while the (possibly swapped) loadHolds still returns it.
    loadHeldPropertyIds: async (org, ids) => {
      const held = new Set((await deps.loadHolds(org, "")).holds.map((h) => h.propertyId));
      return new Set(ids.filter((id) => held.has(id)));
    },
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
    sendEmail: async (userId, message, opts) => {
      sent.push({ channel: "email", userId, text: `${message.subject}\n${message.text}`, idempotencyKey: opts?.idempotencyKey });
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
