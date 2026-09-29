import { expect, it } from "vitest";
import { needsPersonPiles } from "./overview-model";

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
