import { describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => ({ recordLeadEvent: vi.fn() }));

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: { QUALIFIED: "qualified" },
  recordLeadEvent: eventMocks.recordLeadEvent,
}));

import { qualifyProperty } from "./qualify";

function selectResult(data: unknown) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  return query;
}

function updateResult(data: unknown) {
  const query = {
    update: vi.fn(),
    eq: vi.fn(),
    select: vi.fn(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
  };
  query.update.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.select.mockReturnValue(query);
  return query;
}

describe("qualifyProperty permanent DNC", () => {
  it("does not attempt promotion when the property is already locked", async () => {
    const initial = selectResult({ status: "prospect", is_dnc_locked: true });
    const from = vi.fn().mockReturnValueOnce(initial);

    const result = await qualifyProperty(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from } as any,
      "property-1",
      "user-1",
    );

    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("DNC_LOCKED") });
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("reconciles a zero-row promotion as DNC when the lock won the race", async () => {
    const initial = selectResult({ status: "prospect", is_dnc_locked: false });
    const update = updateResult(null);
    const current = selectResult({ status: "prospect", is_dnc_locked: true });
    const from = vi.fn()
      .mockReturnValueOnce(initial)
      .mockReturnValueOnce(update)
      .mockReturnValueOnce(current);

    const result = await qualifyProperty(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from } as any,
      "property-1",
      "user-1",
    );

    expect(result).toMatchObject({ status: "failed", message: expect.stringContaining("DNC_LOCKED") });
    expect(update.eq).toHaveBeenCalledWith("is_dnc_locked", false);
  });

  it("records only a persisted prospect promotion", async () => {
    eventMocks.recordLeadEvent.mockReset().mockResolvedValue(undefined);
    const initial = selectResult({ status: "prospect", is_dnc_locked: false });
    const update = updateResult({ id: "property-1" });
    const from = vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(update);

    const result = await qualifyProperty(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { from } as any,
      "property-1",
      "system:inbound_reply",
    );

    expect(result).toEqual({ status: "qualified" });
    expect(eventMocks.recordLeadEvent).toHaveBeenCalledWith({
      propertyId: "property-1",
      actorType: "system",
      eventType: "qualified",
      payload: { from: "prospect", to: "new_lead" },
    });
  });
});
