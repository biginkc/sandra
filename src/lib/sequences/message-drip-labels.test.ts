import { describe, expect, it, vi } from "vitest";
import { formatMessageDripLabel, messageDripLabels } from "./message-drip-labels";

describe("message drip labels", () => {
  it("labels only a step-run-backed outbound text", () => {
    expect(formatMessageDripLabel("90-day follow-up", 2, 4)).toBe("Drip · 90-day follow-up · text 2 of 4");
    expect(formatMessageDripLabel("90-day follow-up", 0, 4)).toBeNull();
  });

  it("joins message IDs to durable runs and counts text steps only", async () => {
    const rows = {
      sequence_step_runs: [{ message_id: "m1", step_id: "st1" }, { message_id: "m2", step_id: "st3" }],
      sequence_steps: [
        { id: "st1", sequence_id: "s1", step_index: 0, action_type: "send_sms" },
        { id: "st2", sequence_id: "s1", step_index: 1, action_type: "change_status" },
        { id: "st3", sequence_id: "s1", step_index: 2, action_type: "send_sms" },
      ],
      sequences: [{ id: "s1", name: "90-day follow-up" }],
    };
    const client = { from: vi.fn((table: keyof typeof rows) => ({ select: () => ({ in: (field: string, ids: string[]) => Promise.resolve({
      data: rows[table].filter((row) => ids.includes(String(row[field as keyof typeof row]))), error: null,
    }) }) })) };
    expect(await messageDripLabels(client as never, ["m1", "m2", "m3"])).toEqual({
      m1: "Drip · 90-day follow-up · text 1 of 2",
      m2: "Drip · 90-day follow-up · text 2 of 2",
    });
    expect(client.from).toHaveBeenCalledWith("sequence_step_runs");
  });
});
