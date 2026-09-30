import { assertNoUnacknowledgedCanaryFailure } from "../src/lib/sequences/canary-failure-latch";

async function main() {
  await assertNoUnacknowledgedCanaryFailure(
    process.env.GITHUB_RUN_ID ?? "",
    process.env.CANARY_GITHUB_READ_TOKEN ?? "",
  );
  console.log("Prior completed full canary run permits enrollment");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
