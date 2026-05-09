import { describe, it, expect } from "vitest";

describe("slack/dispatch", () => {
  it.todo("dispatchTaskAssignedSlack short-circuits when user pref disabled");
  it.todo("dispatchTaskAssignedSlack short-circuits when no bot token row");
  it.todo(
    "dispatchTaskAssignedSlack calls conversations.open then chat.postMessage",
  );
  it.todo("dispatchTaskAssignedSlack never throws (catches and reportErrors)");
  it.todo(
    "dispatchTaskAssignedSlack persists slack channel + message_ts on the task for later chat.update",
  );
});
