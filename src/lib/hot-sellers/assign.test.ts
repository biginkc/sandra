import { beforeEach, describe, expect, it, vi } from "vitest";

const events = vi.hoisted(() => ({ rows: [] as Array<{ source_type: string; source_id: string; payload: Record<string, unknown> }> }));

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { ASSIGNED: "assigned", AI_ESCALATED: "ai_escalated" },
  recordLeadEvent: vi.fn(async (e: { sourceType: string; sourceId: string; payload: Record<string, unknown> }) => {
    events.rows.push({ source_type: e.sourceType, source_id: e.sourceId, payload: e.payload });
  }),
}));
vi.mock("@/app/(dashboard)/leads/assignment-safety", () => ({ validateActiveAssigneeForProperties: vi.fn() }));

import { recordHotTextOnHeldLead } from "./assign";
import { hotFlagKey } from "./hot";

const ORG = "org-1";
const PROP = "prop-1";
const OWNER_A = "user-a";
const OWNER_B = "user-b";
const FLAG_AT = "2026-10-15T10:00:00.000Z";

type Delivery = { hold_key: string; status: string; recipient_user_id: string };

function makeDb(opts: { owners: string[]; deliveries: Delivery[]; property?: Record<string, unknown> }) {
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
    q.maybeSingle = async () => ({ data: rows()[0] ?? null, error: null });
    q.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
    return q;
  };
  return { from } as never;
}

const KEY = hotFlagKey(PROP, FLAG_AT);
const covered = () => events.rows.at(-1)?.payload.covered_by_hold;

describe("isCoveredByHotHold via recordHotTextOnHeldLead: covered only by a sent alert to the CURRENT owner", () => {
  beforeEach(() => { events.rows.length = 0; });

  it("sent to the current owner: covered", async () => {
    const db = makeDb({ owners: [OWNER_A], deliveries: [{ hold_key: KEY, status: "sent", recipient_user_id: OWNER_A }] });
    expect(await recordHotTextOnHeldLead(db, PROP, "m1", "price_or_offer", {})).toBe(true);
    expect(covered()).toBe(true);
  });

  it("sent to a PREVIOUS owner only (owner changed to B, B has no rows yet): covered - the hold will alert B itself", async () => {
    const db = makeDb({ owners: [OWNER_B], deliveries: [{ hold_key: KEY, status: "sent", recipient_user_id: OWNER_A }] });
    expect(await recordHotTextOnHeldLead(db, PROP, "m2", "price_or_offer", {})).toBe(true);
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

  it("no delivery rows at all for the hold: covered (the hold alerts the owner itself)", async () => {
    const db = makeDb({ owners: [OWNER_A], deliveries: [] });
    await recordHotTextOnHeldLead(db, PROP, "m7", "price_or_offer", {});
    expect(covered()).toBe(true);
  });

  it("owner unresolved (two active owners, no pick): nothing recorded, never covered", async () => {
    const db = makeDb({ owners: [OWNER_A, OWNER_B], deliveries: [{ hold_key: KEY, status: "sent", recipient_user_id: OWNER_A }] });
    expect(await recordHotTextOnHeldLead(db, PROP, "m4", "price_or_offer", {})).toBe(false);
    expect(events.rows).toHaveLength(0);
  });

  it("explicit pick naming a non-owner (owner null): nothing recorded", async () => {
    const db = makeDb({ owners: [OWNER_A], deliveries: [{ hold_key: KEY, status: "sent", recipient_user_id: OWNER_A }] });
    expect(await recordHotTextOnHeldLead(db, PROP, "m5", "price_or_offer", { HOT_LEAD_ASSIGNEE_USER_ID: "someone-else" })).toBe(false);
    expect(events.rows).toHaveLength(0);
  });
});
