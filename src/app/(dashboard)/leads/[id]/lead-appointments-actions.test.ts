import { beforeEach, describe, expect, it, vi } from "vitest";

const or = vi.fn();
const query: Record<string, unknown> = {};
for (const m of ["select", "eq", "in", "order", "limit"]) query[m] = () => query;
query.or = (...a: unknown[]) => { or(...a); return query; };
(query as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ from: () => query }) }));

import { loadLeadAppointmentHistory } from "./lead-appointments-actions";

const PID = "11111111-1111-4111-8111-111111111111";
const TID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => or.mockReset());

describe("loadLeadAppointmentHistory", () => {
  it("passes the cursor timestamp through unchanged", async () => {
    const dueAt = "2026-10-01T15:00:00.123456+00:00";
    const result = await loadLeadAppointmentHistory(PID, { dueAt, id: TID });
    expect(result.ok).toBe(true);
    expect(or).toHaveBeenCalledWith(`due_at.lt."${dueAt}",and(due_at.eq."${dueAt}",id.lt."${TID}")`);
  });

  it.each([
    ["bad property id", "x", { dueAt: "2026-10-01T15:00:00Z", id: TID }],
    ["bad cursor id", PID, { dueAt: "2026-10-01T15:00:00Z", id: `${TID}"),id.neq.(` }],
    ["filter injection in timestamp", PID, { dueAt: '2026-10-01T15:00:00Z"),status.eq.(open', id: TID }],
  ])("rejects %s without querying", async (_n, pid, cursor) => {
    const result = await loadLeadAppointmentHistory(pid, cursor);
    expect(result.ok).toBe(false);
    expect(or).not.toHaveBeenCalled();
  });
});
