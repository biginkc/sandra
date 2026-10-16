import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ rows: [] as Array<{ source_type: string; source_id: string; payload: Record<string, unknown> }> }));

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { ASSIGNED: "assigned", AI_ESCALATED: "ai_escalated" },
  recordLeadEvent: vi.fn(async (e: { sourceType: string; sourceId: string; payload: Record<string, unknown> }) => {
    events.rows.push({ source_type: e.sourceType, source_id: e.sourceId, payload: e.payload });
  }),
}));
vi.mock("@/app/(dashboard)/leads/assignment-safety", () => ({ validateActiveAssigneeForProperties: vi.fn() }));

import { recordHotFailure, recordHotTextOnHeldLead } from "./assign";
import { hotFlagKey } from "./hot";

const ORG = "org-1";
const PROP = "prop-1";
const OWNER_A = "user-a";
const OWNER_B = "user-b";
const FLAG_AT = "2026-10-15T10:00:00.000Z";

type Delivery = { hold_key: string; status: string; recipient_user_id: string };

function makeDb(opts: { owners: string[]; deliveries: Delivery[]; property?: Record<string, unknown>; alertsSince?: string | null | "error"; now?: string }) {
  const alertsSince = opts.alertsSince === undefined ? "2026-10-15T00:00:00.000Z" : opts.alertsSince;
  const property = {
    id: PROP, org_id: ORG, assigned_user_id: null, is_dnc_locked: false, deleted_at: null,
    needs_human_attention: true, last_ai_escalation_reason: "model:price_or_offer", last_ai_escalation_at: FLAG_AT,
    ...opts.property,
  };
  const from = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const q: Record<string, unknown> = {};
    const rows = (): unknown[] => {
      if (table === "properties") return [property];
      if (table === "memberships") return opts.owners.map((u) => ({ user_id: u, role: "owner", access_status: "active", access_expires_at: null, deletion_prepared_at: null }));
      if (table === "hold_alert_deliveries") return opts.deliveries.filter((d) => filters.every(([c, v]) => (d as Record<string, unknown>)[c] === v));
      if (table === "lead_events") return events.rows.filter((e) => filters.every(([c, v]) => (e as Record<string, unknown>)[c] === v)).map((e, i) => ({ id: String(i) }));
      return [];
    };
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { filters.push([c, v]); return q; };
    q.limit = () => q;
    q.maybeSingle = async () => {
      if (table === "hold_alert_settings") {
        if (alertsSince === "error") return { data: null, error: { message: "boom" } };
        return { data: alertsSince ? { alerts_since: alertsSince } : null, error: null };
      }
      return { data: rows()[0] ?? null, error: null };
    };
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
    return q;
  };
  return { from } as never;
}

const KEY = hotFlagKey(PROP, FLAG_AT);
const covered = () => events.rows.at(-1)?.payload.covered_by_hold;

describe("isCoveredByHotHold via recordHotTextOnHeldLead: covered only by a sent alert to the CURRENT owner", () => {
  beforeEach(() => { events.rows.length = 0; vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("sent to the current owner: covered", async () => {
    const db = makeDb({ owners: [OWNER_A], deliveries: [{ hold_key: KEY, status: "sent", recipient_user_id: OWNER_A }] });
    expect(await recordHotTextOnHeldLead(db, PROP, "m1", "price_or_offer", {})).toBe("recorded");
    expect(covered()).toBe(true);
  });

  it("sent to a PREVIOUS owner only (owner changed to B, B has no rows yet) and the hold will alert B (flag after alerts_since, within 7 days): covered", async () => {
    const db = makeDb({ owners: [OWNER_B], deliveries: [{ hold_key: KEY, status: "sent", recipient_user_id: OWNER_A }] });
    expect(await recordHotTextOnHeldLead(db, PROP, "m2", "price_or_offer", {})).toBe("recorded");
    expect(covered()).toBe(true);
    expect(events.rows.at(-1)?.payload.to).toBe(OWNER_B);
  });

  it("sent to both old and current owner: covered", async () => {
    const db = makeDb({
      owners: [OWNER_B],
      deliveries: [
        { hold_key: KEY, status: "sent", recipient_user_id: OWNER_A },
        { hold_key: KEY, status: "sent", recipient_user_id: OWNER_B },
      ],
    });
    await recordHotTextOnHeldLead(db, PROP, "m3", "price_or_offer", {});
    expect(covered()).toBe(true);
  });

  it("current owner has a row that is not sent (pending / failed / skipped / sending): not covered", async () => {
    for (const status of ["pending", "failed", "skipped", "sending"]) {
      events.rows.length = 0;
      const db = makeDb({ owners: [OWNER_A], deliveries: [{ hold_key: KEY, status, recipient_user_id: OWNER_A }] });
      await recordHotTextOnHeldLead(db, PROP, `m-${status}`, "price_or_offer", {});
      expect(covered(), status).toBe(false);
    }
  });

  it("owner B has a failed row while A was sent: not covered", async () => {
    const db = makeDb({
      owners: [OWNER_B],
      deliveries: [
        { hold_key: KEY, status: "sent", recipient_user_id: OWNER_A },
        { hold_key: KEY, status: "failed", recipient_user_id: OWNER_B },
      ],
    });
    await recordHotTextOnHeldLead(db, PROP, "m6", "price_or_offer", {});
    expect(covered()).toBe(false);
  });

  it("no delivery rows at all and the hold will alert the owner (branch b): covered", async () => {
    const db = makeDb({ owners: [OWNER_A], deliveries: [] });
    await recordHotTextOnHeldLead(db, PROP, "m7", "price_or_offer", {});
    expect(covered()).toBe(true);
  });

  it("branch b fails: no rows for the owner but the hold will NOT alert them -> not covered", async () => {
    const cases: Array<[string, Parameters<typeof makeDb>[0]]> = [
      ["flag older than alerts_since", { owners: [OWNER_A], deliveries: [], alertsSince: "2026-10-15T11:00:00.000Z" }],
      ["no settings row", { owners: [OWNER_A], deliveries: [], alertsSince: null }],
      ["settings lookup fails", { owners: [OWNER_A], deliveries: [], alertsSince: "error" }],
      ["flag older than 7 days", { owners: [OWNER_A], deliveries: [], property: { last_ai_escalation_at: "2026-10-15T10:00:00.000Z" }, alertsSince: "2026-10-15T00:00:00.000Z", now: "2026-10-22T10:00:01.000Z" }],
      ["flag before the cutoff", { owners: [OWNER_A], deliveries: [], property: { last_ai_escalation_at: "2026-10-14T10:00:00.000Z" }, alertsSince: "2026-10-01T00:00:00.000Z" }],
    ];
    for (const [label, opts] of cases) {
      events.rows.length = 0;
      vi.setSystemTime(new Date(opts.now ?? "2026-10-15T12:00:00.000Z"));
      await recordHotTextOnHeldLead(makeDb(opts), PROP, `mb-${label}`, "price_or_offer", {});
      expect(covered(), label).toBe(false);
    }
  });

  it("branch b boundary: flag exactly 7 days old is still inside the window", async () => {
    vi.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    const db = makeDb({ owners: [OWNER_A], deliveries: [], property: { last_ai_escalation_at: "2026-10-15T12:00:00.000Z" }, alertsSince: "2026-10-15T00:00:00.000Z" });
    await recordHotTextOnHeldLead(db, PROP, "m-edge", "price_or_offer", {});
    expect(covered()).toBe(true);
  });

  it("owner unresolved (two active owners, no pick): nothing recorded, never covered", async () => {
    const db = makeDb({ owners: [OWNER_A, OWNER_B], deliveries: [{ hold_key: KEY, status: "sent", recipient_user_id: OWNER_A }] });
    expect(await recordHotTextOnHeldLead(db, PROP, "m4", "price_or_offer", {})).toBe("skipped");
    expect(events.rows).toHaveLength(0);
  });

  it("explicit pick naming a non-owner (owner null): nothing recorded", async () => {
    const db = makeDb({ owners: [OWNER_A], deliveries: [{ hold_key: KEY, status: "sent", recipient_user_id: OWNER_A }] });
    expect(await recordHotTextOnHeldLead(db, PROP, "m5", "price_or_offer", { HOT_LEAD_ASSIGNEE_USER_ID: "someone-else" })).toBe("skipped");
    expect(events.rows).toHaveLength(0);
  });
});

describe("recordHotFailure: shares the hold's hot_flag key only when THIS failure set the flag", () => {
  const REASON = "hot_lead_assign_failed";
  const flagged = { last_ai_escalation_reason: REASON };
  const flagAtOf = () => events.rows.at(-1)?.payload.flag_at;

  beforeEach(() => {
    events.rows.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("ourFlagAt equals the stored flag time: the event carries flag_at (shares hot_flag:<property>:<flagAt>)", async () => {
    await recordHotFailure(makeDb({ owners: [OWNER_A], deliveries: [], property: flagged }), PROP, "in-1", REASON, FLAG_AT);
    expect(flagAtOf()).toBe(FLAG_AT);
    expect(events.rows.at(-1)?.payload.covered_by_hold).toBe(false);
  });

  it("same instant in a different textual form still counts as ours", async () => {
    await recordHotFailure(makeDb({ owners: [OWNER_A], deliveries: [], property: { ...flagged, last_ai_escalation_at: "2026-10-15T10:00:00+00:00" } }), PROP, "in-1b", REASON, FLAG_AT);
    expect(flagAtOf()).toBe("2026-10-15T10:00:00+00:00");
  });

  it("ourFlagAt null (the flag was already set by something else): own event, no flag_at", async () => {
    await recordHotFailure(makeDb({ owners: [OWNER_A], deliveries: [], property: flagged }), PROP, "in-2", REASON, null);
    expect(flagAtOf()).toBeNull();
  });

  it("ourFlagAt omitted: own event, no flag_at", async () => {
    await recordHotFailure(makeDb({ owners: [OWNER_A], deliveries: [], property: flagged }), PROP, "in-3", REASON);
    expect(flagAtOf()).toBeNull();
  });

  it("another inbound's flag with the SAME reason but a different time never lends its key", async () => {
    await recordHotFailure(makeDb({ owners: [OWNER_A], deliveries: [], property: flagged }), PROP, "in-4", REASON, "2026-10-15T09:00:00.000Z");
    expect(flagAtOf()).toBeNull();
  });

  it("not ours but the other hold's alert was SENT to the owner: covered_by_hold true", async () => {
    await recordHotFailure(makeDb({ owners: [OWNER_A], deliveries: [{ hold_key: KEY, status: "sent", recipient_user_id: OWNER_A }], property: flagged }), PROP, "in-5", REASON, null);
    expect(flagAtOf()).toBeNull();
    expect(events.rows.at(-1)?.payload.covered_by_hold).toBe(true);
  });

  it("not ours and the other hold's alert is only pending: NOT covered", async () => {
    await recordHotFailure(makeDb({ owners: [OWNER_A], deliveries: [{ hold_key: KEY, status: "pending", recipient_user_id: OWNER_A }], property: flagged }), PROP, "in-6", REASON, null);
    expect(events.rows.at(-1)?.payload.covered_by_hold).toBe(false);
  });
});
