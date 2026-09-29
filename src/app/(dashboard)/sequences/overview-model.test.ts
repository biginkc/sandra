import { expect, it } from "vitest";
import { overviewTotals, needsPersonPiles } from "./overview-model";

it("uses the matching RPC count for each overview box", () => {
  const rows = [{ bucket: "finished_no_reply" as const }, { bucket: "finished_no_reply" as const }, { bucket: "couldnt_send" as const }, { bucket: "needs_sequence" as const }];
  expect(overviewTotals(rows)).toEqual({ finishedNoReply: 2, couldntSend: 1, needsDrip: 1 });
});

it("keeps all three needs-person reasons separate", () => {
  const rows = [
    { property_id: "a", bucket: "finished_no_reply" },
    { property_id: "b", bucket: "couldnt_send" },
    { property_id: "c", bucket: "needs_sequence" },
  ] as const;
  expect(needsPersonPiles([...rows])).toEqual({
    finished_no_reply: [rows[0]], couldnt_send: [rows[1]], needs_sequence: [rows[2]],
  });
});
