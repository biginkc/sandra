// Test-only helpers: an in-memory DirectCallStore. Never imported by production code.
import type { DirectCallStatus } from "./contract";
import { DirectCallLockConflictError, type DirectCallFullRow, type DirectCallOperatorRow, type DirectCallStore, type EventInsertResult, type NewDirectCall } from "./store";
import type { RowPatch } from "./transitions";

/** Mirrors the migration's lock predicate: not terminal, or any teardown still pending. */
export function holdsLock(r: DirectCallFullRow): boolean {
  return !["ended", "failed"].includes(r.status) || r.browser_hangup_pending || r.seller_hangup_pending || r.orphan_hangup_leg_ids.length > 0;
}

export function makeRow(overrides: Partial<DirectCallFullRow> = {}): DirectCallFullRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    org_id: "org",
    operator_user_id: "user-1",
    property_id: null,
    contact_id: null,
    destination_e164: "+15550001111",
    caller_id_e164: "+15550002222",
    status: "browser_connecting",
    browser_leg_id: "browser-leg",
    seller_leg_id: null,
    browser_command_id: "22222222-2222-4222-8222-222222222222",
    browser_hangup_pending: false,
    seller_hangup_pending: false,
    browser_hangup_acked_at: null,
    seller_hangup_acked_at: null,
    orphan_hangup_leg_ids: [],
    seller_dial_state: null,
    hangup_cause: null,
    failure_reason: null,
    client_request_id: "33333333-3333-4333-8333-333333333333",
    created_at: "2026-10-01T12:00:00.000Z",
    connected_at: null,
    ended_at: null,
    updated_at: "2026-10-01T12:00:00.000Z",
    ...overrides,
  };
}

export class FakeStore implements DirectCallStore {
  calls = new Map<string, DirectCallFullRow>();
  events = new Map<string, { directCallId: string | null; processed: boolean; type: string }>();
  operators = new Map<string, DirectCallOperatorRow>();
  failEventInsert = false;
  private seq = 0;

  add(row: DirectCallFullRow) {
    this.calls.set(row.id, row);
    return row;
  }
  async insertEvent(e: { provider_event_id: string; direct_call_id: string | null; event_type: string }): Promise<EventInsertResult> {
    if (this.failEventInsert) throw new Error("db down");
    const existing = this.events.get(e.provider_event_id);
    if (existing) return existing.processed ? "duplicate_processed" : "duplicate_unprocessed";
    this.events.set(e.provider_event_id, { directCallId: e.direct_call_id, processed: false, type: e.event_type });
    return "inserted";
  }
  async markEventProcessed(id: string) {
    const e = this.events.get(id);
    if (e) e.processed = true;
  }
  async findByLeg(leg: string) {
    return [...this.calls.values()].find((r) => r.browser_leg_id === leg || r.seller_leg_id === leg) ?? null;
  }
  async findById(id: string) {
    return this.calls.get(id) ?? null;
  }
  async findOwned(id: string, userId: string) {
    const r = this.calls.get(id);
    return r && r.operator_user_id === userId ? r : null;
  }
  async findByRequest(userId: string, requestId: string) {
    return [...this.calls.values()].find((r) => r.operator_user_id === userId && r.client_request_id === requestId) ?? null;
  }
  async findActiveForUser(userId: string) {
    return [...this.calls.values()].find((r) => r.operator_user_id === userId && holdsLock(r)) ?? null;
  }
  async insertCall(call: NewDirectCall) {
    if (await this.findActiveForUser(call.operator_user_id)) return "conflict" as const;
    const row = makeRow({
      ...call,
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      status: "browser_connecting",
      browser_leg_id: null,
    });
    this.calls.set(row.id, row);
    return { row };
  }
  async updateIfStatus(id: string, statuses: DirectCallStatus[], patch: RowPatch) {
    const row = this.calls.get(id);
    if (!row || !statuses.includes(row.status)) return null;
    const next = { ...row, ...patch } as DirectCallFullRow;
    this.assertLock(next);
    this.calls.set(id, next);
    return next;
  }
  async setBrowserLeg(id: string, leg: string) {
    const row = this.calls.get(id);
    if (row && !row.browser_leg_id) this.calls.set(id, { ...row, browser_leg_id: leg });
  }
  async setSellerLegIfNull(id: string, leg: string) {
    const row = this.calls.get(id);
    if (!row || row.seller_leg_id) return false;
    this.calls.set(id, { ...row, seller_leg_id: leg, seller_dial_state: "sent" });
    return true;
  }
  async markSellerDialSent(id: string) {
    const row = this.calls.get(id);
    if (row?.seller_dial_state === "pending") this.calls.set(id, { ...row, seller_dial_state: "sent" });
  }
  /** Emulates the partial unique index: a row entering the lock set while another holds it is rejected. */
  private assertLock(next: DirectCallFullRow) {
    if (!holdsLock(next)) return;
    const other = [...this.calls.values()].find((r) => r.id !== next.id && r.operator_user_id === next.operator_user_id && holdsLock(r));
    if (other) throw new DirectCallLockConflictError();
  }
  async setLegCleanup(id: string, role: "browser" | "seller", pending: boolean) {
    const row = this.calls.get(id);
    if (!row) return;
    const next = {
      ...row,
      [role === "browser" ? "browser_hangup_pending" : "seller_hangup_pending"]: pending,
      ...(pending ? {} : { [role === "browser" ? "browser_hangup_acked_at" : "seller_hangup_acked_at"]: null }),
    } as DirectCallFullRow;
    this.assertLock(next);
    this.calls.set(id, next);
  }
  async markLegHangupAcked(id: string, role: "browser" | "seller", at: string) {
    const row = this.calls.get(id);
    if (row) this.calls.set(id, { ...row, [role === "browser" ? "browser_hangup_acked_at" : "seller_hangup_acked_at"]: at });
  }
  async addOrphanLeg(id: string, legId: string) {
    const row = this.calls.get(id);
    if (!row || row.orphan_hangup_leg_ids.includes(legId)) return;
    const next = { ...row, orphan_hangup_leg_ids: [...row.orphan_hangup_leg_ids, legId] };
    this.assertLock(next);
    this.calls.set(id, next);
  }
  async removeOrphanLeg(id: string, legId: string) {
    const row = this.calls.get(id);
    if (row) this.calls.set(id, { ...row, orphan_hangup_leg_ids: row.orphan_hangup_leg_ids.filter((l) => l !== legId) });
  }
  async getOperator(userId: string) {
    return this.operators.get(userId) ?? null;
  }
  async insertOperator(row: { user_id: string; org_id: string; telnyx_credential_id: string; sip_username: string }) {
    const full = { ...row, created_at: "2026-10-01T00:00:00.000Z" };
    this.operators.set(row.user_id, full);
    return full;
  }
}
