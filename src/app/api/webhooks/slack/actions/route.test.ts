import { describe, it, expect } from "vitest";

describe("webhooks/slack/actions route", () => {
  it.todo("rejects with 401 when signature is invalid");
  it.todo("acks 200 within 3s on valid block_actions payload");
  it.todo(
    "schedules after() to call completeTaskFromSlack and refreshSlackMessage",
  );
  it.todo("validates action_id allowlist (mark_done only)");
  it.todo("validates payload.actions[0].value is a UUID before any DB lookup");
});
