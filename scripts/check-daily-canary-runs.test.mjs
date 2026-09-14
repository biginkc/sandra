import assert from "node:assert/strict";
import test from "node:test";

import { evaluateDailyRun, previousUtcDate } from "./check-daily-canary-runs.mjs";

test("previous UTC day crosses month and year boundaries", () => {
  assert.equal(previousUtcDate(new Date("2027-01-01T02:10:00Z")), "2026-12-31");
});

test("only a completed successful scheduled main run counts", () => {
  const workflow = "canary-leads-browser.yml";
  const date = "2026-09-14";
  const base = {
    event: "schedule", head_branch: "main", created_at: `${date}T20:00:00Z`,
    status: "completed", conclusion: "success", html_url: "https://github.com/run/1",
  };
  assert.equal(evaluateDailyRun(workflow, date, []).status, "MISSING");
  assert.equal(evaluateDailyRun(workflow, date, [{ ...base, event: "workflow_dispatch" }]).status, "MISSING");
  assert.equal(evaluateDailyRun(workflow, date, [{ ...base, head_branch: "feature" }]).status, "MISSING");
  assert.equal(evaluateDailyRun(workflow, date, [{ ...base, status: "in_progress" }]).status, "INCOMPLETE");
  assert.equal(evaluateDailyRun(workflow, date, [{ ...base, conclusion: "failure" }]).status, "FAIL");
  assert.equal(evaluateDailyRun(workflow, date, [base]).status, "PASS");
});
