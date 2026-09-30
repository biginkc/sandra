import { assertNoUnacknowledgedCanaryFailure } from "../src/lib/sequences/canary-failure-latch";

await assertNoUnacknowledgedCanaryFailure(
  process.env.GITHUB_RUN_ID ?? "",
  process.env.CANARY_GITHUB_READ_TOKEN ?? "",
);
console.log("Prior completed full canary run permits enrollment");
