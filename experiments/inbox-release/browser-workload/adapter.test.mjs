import test from "node:test";
import assert from "node:assert/strict";

import { planWork, WorkloadBlocked } from "./adapter.mjs";

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function scenario(number, targets = 2) {
  return {
    tenantId: "org-tenant",
    operatorId: id(number + 200),
    orgId: id(number),
    storageState: `/owned/auth-${number}.json`,
    assigneeId: id(number + 100),
    conversationIds: Array.from({ length: targets }, (_, index) => id(number * 10 + index + 1)),
  };
}

test("plans bounded cycles across distinct tenant/operator fixtures", () => {
  const jobs = planWork({ scenarios: [{ ...scenario(1), orgId: id(1), tenantId: "tenant-a" }, { ...scenario(2), orgId: id(2), tenantId: "tenant-b" }], cycles: 4, concurrency: 2, tenantCount: 2 });
  assert.deepEqual(jobs.map((job) => [job.scenario.tenantId, job.conversationId]), [
    ["tenant-a", id(11)],
    ["tenant-b", id(21)],
    ["tenant-a", id(12)],
    ["tenant-b", id(22)],
  ]);
});

test("allows concurrent operators to share an org while keeping auth states distinct", () => {
  const jobs = planWork({ scenarios: [scenario(1), { ...scenario(2), orgId: id(1) }], cycles: 2, concurrency: 2, tenantCount: 1 });
  assert.equal(new Set(jobs.map((job) => job.scenario.orgId)).size, 1);
  assert.equal(new Set(jobs.map((job) => job.scenario.operatorId)).size, 2);
});

test("exercises extra operator mappings instead of silently ignoring them", () => {
  const scenarios = [scenario(1), { ...scenario(2), orgId: id(1) }, { ...scenario(3), orgId: id(1) }];
  const jobs = planWork({ scenarios, cycles: 3, concurrency: 2, tenantCount: 1 });
  assert.deepEqual(jobs.map((job) => job.scenario.operatorId), [id(201), id(202), id(203)]);
});

test("rejects one auth state being reused for multiple measured operators", () => {
  assert.throws(
    () => planWork({ scenarios: [{ ...scenario(1), tenantId: "tenant-a" }, { ...scenario(1), tenantId: "tenant-b", operatorId: id(202) }], cycles: 2, concurrency: 2, tenantCount: 1 }),
    (error) => error instanceof WorkloadBlocked && /storage state/.test(error.message),
  );
});

test("rejects a measured workload without enough distinct pre-seeded targets", () => {
  assert.throws(
    () => planWork({ scenarios: [{ ...scenario(1, 1), orgId: id(1) }, { ...scenario(2, 1), orgId: id(2) }], cycles: 3, concurrency: 2, tenantCount: 2 }),
    (error) => error instanceof WorkloadBlocked && /no unique pre-seeded conversation/.test(error.message),
  );
});

test("does not count the detail shell before delayed history content is ready", async () => {
  let state = "loading";
  setTimeout(() => { state = "ready"; }, 10);
  await (await import("./adapter.mjs")).waitForDetailState(async () => state, 100, 1);
  assert.equal(state, "ready");
});
