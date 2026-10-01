// Test-only helpers: an in-memory DirectCallStore. Never imported by production code.
import type { DirectCallStatus } from "./contract";
import type { BeginOutcome, CleanupUpdate, DirectCallCleanupRow, DirectCallFullRow, DirectCallOperatorRow, DirectCallStore, EventInsertResult, NewDirectCall } from "./store";
import { DISPATCH_MARKER_RESPONSE_ALLOWANCE_SECS, type CleanupSpec, type RowPatch } from "./transitions";

export function makeRow(overrides: Partial<DirectCallFullRow> = {}): DirectCallFullRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    org_id: "org",
    operator_user_id: "user-1",
    property_id: null,
    contact_id: null,
    destination_e164: "+15550001111",
    caller_id_e164: "+15550002222",
    time_limit_secs: 7200,
    browser_dial_started_at: null,
    status: "browser_connecting",
    browser_leg_id: "browser-leg",
    seller_leg_id: null,
    browser_command_id: "22222222-2222-4222-8222-222222222222",
    seller_dial_state: null,
    hangup_cause: null,
    failure_reason: null,
    client_request_id: "33333333-3333-4333-8333-333333333333",
    created_at: "2026-10-01T12:00:00.000Z",
    connected_at: null,
    ended_at: null,
    updated_at: "2026-10-01T12:00:00.000Z",
    resume_pending: false,
    resume_claimed_at: null,
    ...overrides,
  };
}

export class FakeStore implements DirectCallStore {
  calls = new Map<string, DirectCallFullRow>();
  cleanups = new Map<string, DirectCallCleanupRow>();
  events = new Map<string, { directCallId: string | null; processed: boolean; type: string; legId?: string | null }>();
  operators = new Map<string, DirectCallOperatorRow>();
  failEventInsert = false;
  /** Injected clock (mirrors the app clock used for next_attempt_at / created_at of cleanup rows). */
  clock: () => Date = () => new Date("2026-10-01T12:00:00.000Z");
  private seq = 0;
  private cseq = 0;

  add(row: DirectCallFullRow) {
    this.calls.set(row.id, row);
    return row;
  }
  /** Test helper: add an open cleanup row. */
  addCleanup(over: Partial<DirectCallCleanupRow> & { direct_call_id: string; kind: "leg" | "unresolved_dial" }): DirectCallCleanupRow {
    const call = this.calls.get(over.direct_call_id);
    const now = this.clock().toISOString();
    const row: DirectCallCleanupRow = {
      id: `cleanup-${++this.cseq}`,
      org_id: call?.org_id ?? "org",
      operator_user_id: call?.operator_user_id ?? "user-1",
      leg_id: null,
      dial_role: null,
      dial_started_at: null,
      resolve_after: null,
      backstop_at: null,
      attempts: 0,
      acked_at: null,
      next_attempt_at: now,
      confirmed_at: null,
      empty_matches: 0,
      last_error: null,
      created_at: now,
      ...over,
    };
    this.cleanups.set(row.id, row);
    return row;
  }
  openFor(callId: string) {
    return [...this.cleanups.values()].filter((c) => c.direct_call_id === callId && !c.confirmed_at);
  }
  legRow(legId: string) {
    return [...this.cleanups.values()].find((c) => c.leg_id === legId);
  }
  private insertSpecs(row: DirectCallFullRow, specs: CleanupSpec[]) {
    for (const spec of specs) {
      if (spec.kind === "leg") {
        if (!this.legRow(spec.legId)) this.addCleanup({ direct_call_id: row.id, kind: "leg", leg_id: spec.legId });
      } else if (![...this.cleanups.values()].some((c) => c.direct_call_id === row.id && c.kind === "unresolved_dial" && c.dial_role === spec.role)) {
        this.addDialRow(row.id, spec.role, spec.timeoutSecs, spec.timeLimitSecs);
      }
    }
  }
  private addDialRow(callId: string, role: "browser" | "seller", _timeoutSecs: number, _timeLimitSecs: number) {
    return this.addCleanup({
      direct_call_id: callId,
      kind: "unresolved_dial",
      dial_role: role,
      dial_started_at: null,
      resolve_after: null,
      backstop_at: null,
      next_attempt_at: this.clock().toISOString(),
    });
  }
  private resolveDial(callId: string, role: "browser" | "seller") {
    for (const c of this.cleanups.values()) {
      if (c.direct_call_id === callId && c.kind === "unresolved_dial" && c.dial_role === role && !c.confirmed_at) c.confirmed_at = this.clock().toISOString();
    }
  }
  async insertEvent(e: { provider_event_id: string; direct_call_id: string | null; event_type: string; payload?: unknown }): Promise<EventInsertResult> {
    if (this.failEventInsert) throw new Error("db down");
    const existing = this.events.get(e.provider_event_id);
    if (existing) return existing.processed ? "duplicate_processed" : "duplicate_unprocessed";
    const legId = (e.payload as { data?: { payload?: { call_control_id?: unknown } } } | undefined)?.data?.payload?.call_control_id;
    this.events.set(e.provider_event_id, { directCallId: e.direct_call_id, processed: false, type: e.event_type, legId: typeof legId === "string" ? legId : null });
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
    return [...this.calls.values()].find((r) => r.operator_user_id === userId && !["ended", "failed"].includes(r.status)) ?? null;
  }
  /** Mirrors direct_call_operator_busy. */
  async operatorBusy(userId: string) {
    if (await this.findActiveForUser(userId)) return "call" as const;
    if ([...this.cleanups.values()].some((c) => c.operator_user_id === userId && !c.confirmed_at)) return "cleanup" as const;
    return null;
  }
  /** Mirrors direct_call_begin. Synchronous body: emulates the advisory lock's serialisation. */
  async beginCall(call: NewDirectCall): Promise<BeginOutcome> {
    const dup = [...this.calls.values()].find((r) => r.operator_user_id === call.operator_user_id && r.client_request_id === call.client_request_id);
    if (dup) return { outcome: "duplicate_request", row: dup };
    if ([...this.calls.values()].some((r) => r.operator_user_id === call.operator_user_id && !["ended", "failed"].includes(r.status))) return { outcome: "busy_call" };
    if ([...this.cleanups.values()].some((c) => c.operator_user_id === call.operator_user_id && !c.confirmed_at)) return { outcome: "busy_cleanup" };
    const row = makeRow({
      ...call,
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      status: "browser_connecting",
      browser_leg_id: null,
      created_at: this.clock().toISOString(),
      updated_at: this.clock().toISOString(),
    });
    this.calls.set(row.id, row);
    this.addDialRow(row.id, "browser", 30, row.time_limit_secs);
    return { outcome: "created", row };
  }
  async cancelRequest(userId: string, orgId: string, requestId: string) {
    const dup = await this.findByRequest(userId, requestId);
    if (dup) return { outcome: "existing" as const, row: dup };
    const row = makeRow({
      id: `00000000-0000-4000-8000-${String(++this.seq).padStart(12, "0")}`,
      org_id: orgId,
      operator_user_id: userId,
      destination_e164: "",
      caller_id_e164: "",
      status: "failed",
      failure_reason: "cancelled_before_start",
      ended_at: this.clock().toISOString(),
      browser_leg_id: null,
      client_request_id: requestId,
    });
    this.calls.set(row.id, row);
    return { outcome: "tombstoned" as const, row };
  }
  /**
   * Mirrors direct_call_apply: CAS on status, resolve rule, the cleanup rows, then (for a move to
   * ending/ended/failed) a leg row for every leg on the CURRENT row with no ended evidence, and the
   * resume_pending flag.
   */
  async updateIfStatus(id: string, statuses: string[], patch: RowPatch, cleanups: CleanupSpec[] = []) {
    const row = this.calls.get(id);
    if (!row || !statuses.includes(row.status)) return null;
    let next = { ...row, ...patch, updated_at: this.clock().toISOString() } as DirectCallFullRow;
    this.calls.set(id, next);
    if ("browser_leg_id" in patch) this.resolveDial(id, "browser");
    if ("seller_leg_id" in patch || patch.seller_dial_state === "sent") this.resolveDial(id, "seller");
    this.insertSpecs(next, cleanups);
    if (["ending", "ended", "failed"].includes(next.status) && next.status !== row.status) {
      const hungUp = new Set([...this.events.values()].filter((e) => e.type === "call.hangup" && e.legId).map((e) => e.legId as string));
      const live = [next.browser_leg_id, next.seller_leg_id].filter((leg): leg is string => Boolean(leg) && !hungUp.has(leg as string));
      this.insertSpecs(next, live.map((legId) => ({ kind: "leg", legId }) as CleanupSpec));
    }
    const terminal = (status: string) => ["ended", "failed"].includes(status);
    if (
      terminal(next.status) && !terminal(row.status) && !next.connected_at && next.property_id &&
      ![...this.calls.values()].some((o) => o.property_id === next.property_id && o.id !== next.id && !terminal(o.status))
    ) {
      next = { ...next, resume_pending: true };
      this.calls.set(id, next);
    }
    return next;
  }
  /** Mirrors direct_call_resume_claim. */
  async claimPendingResumes(userId: string, now: string, leaseSecs: number) {
    const cutoff = new Date(now).getTime() - leaseSecs * 1000;
    const due = [...this.calls.values()].filter(
      (r) => r.operator_user_id === userId && r.resume_pending && (!r.resume_claimed_at || new Date(r.resume_claimed_at).getTime() <= cutoff),
    );
    for (const r of due) this.calls.set(r.id, { ...r, resume_claimed_at: now });
    return due.map((r) => this.calls.get(r.id)!);
  }
  async clearResumePending(callId: string) {
    const r = this.calls.get(callId);
    if (r) this.calls.set(callId, { ...r, resume_pending: false, resume_claimed_at: null });
  }
  async setTarget(id: string, target: { property_id: string | null; contact_id: string | null; destination_e164: string }) {
    const row = this.calls.get(id);
    // Mirrors direct_call_set_target: also the untouched reservation of a request cancelled during prepare.
    const untouched = row && row.status === "ending" && !row.property_id && !row.contact_id && row.destination_e164 === "" && !row.connected_at;
    if (row && (row.status === "browser_connecting" || untouched)) this.calls.set(id, { ...row, ...target });
  }
  async discardReservation(id: string) {
    const row = this.calls.get(id);
    if (row && row.status === "browser_connecting" && !row.browser_leg_id && !row.seller_leg_id) {
      this.calls.delete(id);
      for (const [k, c] of this.cleanups) if (c.direct_call_id === id) this.cleanups.delete(k);
    }
  }
  /** Mirrors direct_call_dial_succeeded. */
  async dialSucceeded(id: string, leg: string, role: "browser" | "seller") {
    const row = this.calls.get(id);
    if (!row) return false;
    const column = role === "browser" ? "browser_leg_id" : "seller_leg_id";
    let stored = false;
    let next = row;
    if (!row[column]) {
      next = { ...row, [column]: leg, ...(role === "seller" ? { seller_dial_state: "sent" as const } : {}) };
      stored = true;
    } else if (row[column] === leg) {
      if (role === "seller" && row.seller_dial_state === "pending") next = { ...row, seller_dial_state: "sent" };
      stored = true;
    }
    this.calls.set(id, next);
    this.resolveDial(id, role);
    if (!stored || ["ending", "ended", "failed"].includes(row.status) || row.failure_reason === "teardown_pending") {
      this.insertSpecs(next, [{ kind: "leg", legId: leg }]);
    }
    return stored;
  }
  async dialRejected(id: string, role: "browser" | "seller") {
    this.resolveDial(id, role);
  }
  async markDialStarted(id: string, role: "browser" | "seller", startedAt: string, timeoutSecs: number, timeLimitSecs: number) {
    const call = this.calls.get(id);
    const row = [...this.cleanups.values()].find((c) => c.direct_call_id === id && c.kind === "unresolved_dial" && c.dial_role === role && !c.confirmed_at);
    if (!call || !row || row.dial_started_at || call.failure_reason === "teardown_pending" ||
      (role === "browser" && call.status !== "browser_connecting") ||
      (role === "seller" && (call.status !== "seller_dialing" || call.seller_dial_state !== "pending")) ||
      !Number.isSafeInteger(timeoutSecs) || timeoutSecs < 0 || !Number.isSafeInteger(timeLimitSecs) || timeLimitSecs < 30 || timeLimitSecs > call.time_limit_secs) return false;
    const atMs = new Date(startedAt).getTime();
    row.dial_started_at = startedAt;
    row.resolve_after = new Date(atMs + (timeoutSecs + DISPATCH_MARKER_RESPONSE_ALLOWANCE_SECS + 15) * 1000).toISOString();
    // Telnyx's time_limit_secs is the active leg window after answer. Include the 30s ring window,
    // the marker-response allowance, and the fixed 60s reconciliation grace before time resolution.
    row.backstop_at = new Date(atMs + (timeoutSecs + DISPATCH_MARKER_RESPONSE_ALLOWANCE_SECS + timeLimitSecs + 60) * 1000).toISOString();
    row.next_attempt_at = row.resolve_after;
    if (role === "browser") this.calls.set(id, { ...call, browser_dial_started_at: startedAt, updated_at: startedAt });
    return true;
  }
  async hasActiveCallForProperty(propertyId: string, excludeId: string | null) {
    return [...this.calls.values()].some((r) => r.property_id === propertyId && r.id !== excludeId && !["ended", "failed"].includes(r.status));
  }
  async addLegCleanup(callId: string, legId: string) {
    const row = this.calls.get(callId);
    if (row) this.insertSpecs(row, [{ kind: "leg", legId }]);
  }
  async confirmLegCleanup(legId: string, at: string) {
    const c = this.legRow(legId);
    if (c && !c.confirmed_at) c.confirmed_at = at;
  }
  /** Mirrors direct_call_cleanup_claim (lease pushes next_attempt_at out). */
  async claimDueCleanups(userId: string, now: string, leaseSecs: number, limit: number) {
    const due = [...this.cleanups.values()].filter((c) => {
      if (c.operator_user_id !== userId || c.confirmed_at || c.next_attempt_at > now) return false;
      if (c.kind === "leg") return true;
      const d = this.calls.get(c.direct_call_id);
      return Boolean(d && (["ending", "ended", "failed"].includes(d.status) || d.failure_reason === "teardown_pending"));
    })
      .sort((a, b) => Number(a.kind === "leg") - Number(b.kind === "leg") || a.created_at.localeCompare(b.created_at))
      .slice(0, limit);
    for (const c of due) c.next_attempt_at = new Date(new Date(now).getTime() + leaseSecs * 1000).toISOString();
    return due.map((c) => ({ ...c }));
  }
  async updateCleanup(id: string, patch: CleanupUpdate) {
    const c = this.cleanups.get(id);
    if (c) Object.assign(c, patch);
  }
  async openCleanupsForCall(callId: string) {
    return this.openFor(callId).map((c) => ({ ...c }));
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
