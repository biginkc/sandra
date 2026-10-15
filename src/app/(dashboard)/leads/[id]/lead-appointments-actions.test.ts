import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = [string, ...unknown[]];
let calls: Call[] = [];
let response: { data: unknown; error: unknown } = { data: [], error: null };
function makeQuery() {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "limit", "or"]) {
    q[m] = (...args: unknown[]) => { calls.push([m, ...args]); return q; };
  }
  q.then = (resolve: (v: unknown) => void) => resolve(response);
  return q;
}
const from = vi.fn(() => makeQuery());
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from }) }));

import { loadLeadAppointmentHistory } from "./lead-appointments-actions";

const PID = "11111111-1111-4111-8111-111111111111";
const TID = "22222222-2222-4222-8222-222222222222";
const row = (i: number, due = `2026-10-01T15:00:${String(59 - i).padStart(2, "0")}+00:00`) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `t${i}`, due_at: due, end_at: null,
  assignee_id: "rep", type: "appointment", status: "completed", outcome: "held",
});

beforeEach(() => { calls = []; from.mockClear(); response = { data: [], error: null }; });

describe("loadLeadAppointmentHistory", () => {
  it("scopes to the property, finished appointment-like tasks, newest first, page+1 rows", async () => {
    await loadLeadAppointmentHistory(PID);
    expect(from).toHaveBeenCalledWith("tasks");
    expect(calls).toContainEqual(["eq", "related_property_id", PID]);
    expect(calls).toContainEqual(["in", "type", ["appointment", "callback", "follow_up"]]);
    expect(calls).toContainEqual(["in", "status", ["completed", "cancelled"]]);
    expect(calls).toContainEqual(["order", "due_at", { ascending: false }]);
    expect(calls).toContainEqual(["order", "id", { ascending: false }]);
    expect(calls).toContainEqual(["limit", 21]);
    expect(calls.some((c) => c[0] === "or")).toBe(false);
  });

  it("returns 20 rows and a cursor at the 20th row when 21 come back", async () => {
    response = { data: Array.from({ length: 21 }, (_, i) => row(i)), error: null };
    const result = await loadLeadAppointmentHistory(PID);
    if (!result.ok) throw new Error("expected ok");
    expect(result.rows).toHaveLength(20);
    expect(result.hasMore).toBe(true);
    expect(result.cursor).toEqual({ dueAt: row(19).due_at, id: row(19).id });
  });

  it("uses an id tie-break so rows with the same due_at are not skipped", async () => {
    const tied = "2026-10-01T15:00:00.123456+00:00";
    await loadLeadAppointmentHistory(PID, { dueAt: tied, id: TID });
    expect(calls).toContainEqual(["or", `due_at.lt."${tied}",and(due_at.eq."${tied}",id.lt."${TID}")`]);
  });

  it("reports the terminal page", async () => {
    response = { data: [row(1), row(2)], error: null };
    const result = await loadLeadAppointmentHistory(PID, { dueAt: row(0).due_at, id: TID });
    expect(result).toMatchObject({ ok: true, hasMore: false, cursor: null });
  });

  it("fails closed on a database error", async () => {
    response = { data: null, error: { message: "boom" } };
    expect(await loadLeadAppointmentHistory(PID)).toMatchObject({ ok: false });
  });

  it.each([
    ["bad property id", "x", { dueAt: "2026-10-01T15:00:00Z", id: TID }],
    ["bad cursor id", PID, { dueAt: "2026-10-01T15:00:00Z", id: `${TID}"),id.neq.(` }],
    ["filter injection in timestamp", PID, { dueAt: '2026-10-01T15:00:00Z"),status.eq.(open', id: TID }],
  ])("rejects %s without querying", async (_n, pid, cursor) => {
    expect((await loadLeadAppointmentHistory(pid, cursor)).ok).toBe(false);
    expect(from).not.toHaveBeenCalled();
  });
});
