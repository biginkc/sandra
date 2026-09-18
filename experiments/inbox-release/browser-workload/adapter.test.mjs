import test from "node:test";
import assert from "node:assert/strict";

import { planWork, WorkloadBlocked } from "./adapter.mjs";

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

function scenario(number, targets = 2) {
  return {
    tenantId: `tenant-${number}`,
    orgId: id(number),
    storageState: `/owned/auth-${number}.json`,
    assigneeId: id(number + 100),
    conversationIds: Array.from({ length: targets }, (_, index) => id(number * 10 + index + 1)),
  };
}

test("plans bounded cycles across distinct tenant/operator fixtures", () => {
  const jobs = planWork({ scenarios: [scenario(1), scenario(2)], cycles: 4, concurrency: 2, tenantCount: 2 });
  assert.deepEqual(jobs.map((job) => [job.scenario.tenantId, job.conversationId]), [
    ["tenant-1", id(11)],
    ["tenant-2", id(21)],
    ["tenant-1", id(12)],
    ["tenant-2", id(22)],
  ]);
});

test("rejects one auth state being reused for multiple measured tenants", () => {
  assert.throws(
    () => planWork({ scenarios: [{ ...scenario(1), tenantId: "tenant-a" }, { ...scenario(1), tenantId: "tenant-b" }], cycles: 1, concurrency: 2, tenantCount: 2 }),
    (error) => error instanceof WorkloadBlocked && /storage state/.test(error.message),
  );
});

test("rejects a measured workload without enough distinct pre-seeded targets", () => {
  assert.throws(
    () => planWork({ scenarios: [scenario(1, 1), scenario(2, 1)], cycles: 3, concurrency: 2, tenantCount: 2 }),
    (error) => error instanceof WorkloadBlocked && /no unique pre-seeded conversation/.test(error.message),
  );
});
