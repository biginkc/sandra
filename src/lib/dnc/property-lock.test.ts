import { describe, expect, it, vi } from "vitest";

import {
  assertAppointmentTaskPropertyDncUnlocked,
  assertContactDncUnlocked,
  assertPropertyDncUnlocked,
  partitionPropertyDncLocks,
} from "./property-lock";

function propertyBuilder(rows: unknown[]) {
  const result = Promise.resolve({ data: rows, error: null });
  const query = {
    select: vi.fn(),
    in: vi.fn(),
    is: vi.fn(),
    then: result.then.bind(result),
  };
  query.select.mockReturnValue(query);
  query.in.mockReturnValue(query);
  query.is.mockReturnValue(query);
  return query;
}

describe("property DNC lock helpers", () => {
  it("maps the contact database guard to the same permanent lock error", async () => {
    const rpc = vi.fn().mockResolvedValue({
      error: { message: "DNC_LOCKED: permanently locked contacts are read-only" },
    });

    const result = await assertContactDncUnlocked(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { rpc } as any,
      "contact-1",
    );

    expect(rpc).toHaveBeenCalledWith("assert_contact_dnc_unlocked", {
      p_contact_id: "contact-1",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "DNC_LOCKED" } });
  });

  it("uses the appointment-task database guard before lifecycle mutations", async () => {
    const rpc = vi.fn().mockResolvedValue({
      error: { message: "DNC_LOCKED: related property is read-only" },
    });

    const result = await assertAppointmentTaskPropertyDncUnlocked(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { rpc } as any,
      "task-1",
    );

    expect(rpc).toHaveBeenCalledWith("assert_appointment_task_dnc_unlocked", {
      p_task_id: "task-1",
    });
    expect(result).toMatchObject({ ok: false, error: { code: "DNC_LOCKED" } });
  });

  it("maps the database guard to a stable locked error", async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        error: { message: "DNC_LOCKED: permanently locked properties are read-only" },
      }),
    };

    await expect(assertPropertyDncUnlocked(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      "property-1",
    )).resolves.toMatchObject({
      ok: false,
      error: { code: "DNC_LOCKED" },
    });
  });

  it("partitions mixed batches without treating missing rows as unlocked", async () => {
    const supabase = {
      from: vi.fn(() => propertyBuilder([
        { id: "open", is_dnc_locked: false },
        { id: "locked", is_dnc_locked: true },
      ])),
    };

    await expect(partitionPropertyDncLocks(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase as any,
      ["open", "locked", "missing", "locked"],
    )).resolves.toEqual({
      ok: true,
      data: {
        unlocked: ["open"],
        locked: ["locked"],
        missing: ["missing"],
      },
    });
  });
});
