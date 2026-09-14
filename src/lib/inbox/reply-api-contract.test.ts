import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { INBOX_REPLY_RECIPIENT_LIMIT } from "./reply-api-contract";

const RECIPIENT_SQL = join(
  process.cwd(),
  "experiments/inbox-reply-preparation/recipient.sql",
);

describe("D5 bulk-reply recipient cap parity", () => {
  it("keeps INBOX_REPLY_RECIPIENT_LIMIT in sync with inbox_reply_preparation.recipient_limit()", () => {
    const source = readFileSync(RECIPIENT_SQL, "utf8");
    const match = /CREATE FUNCTION inbox_reply_preparation\.recipient_limit\(\)[^$]*\$\$\s*SELECT (\d+)\s*\$\$/.exec(
      source,
    );
    expect(
      match,
      "recipient_limit() definition not found or shape changed in recipient.sql",
    ).not.toBeNull();
    const sqlLimit = Number(match?.[1]);
    expect(sqlLimit).toBe(INBOX_REPLY_RECIPIENT_LIMIT);
  });
});
