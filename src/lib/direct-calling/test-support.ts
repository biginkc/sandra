// Test-only helpers: an in-memory DirectCallStore. Never imported by production code.
import type { DirectCallStatus } from "./contract";
import type { DirectCallFullRow, DirectCallOperatorRow, DirectCallStore, EventInsertResult, NewDirectCall } from "./store";
import type { RowPatch } from "./transitions";

const LIVE = new Set<DirectCallStatus>(["browser_connecting", "seller_dialing", "connected", "ending"]);

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
    return [...this.calls.values()].find((r) => r.operator_user_id === userId && LIVE.has(r.status)) ?? null;
  }
  async expireStale() {}
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
    this.calls.set(id, { ...row, seller_leg_id: leg });
    return true;
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
