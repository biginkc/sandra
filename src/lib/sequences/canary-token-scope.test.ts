import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { readCanaryControl } from "./canary-controls";
import { assertCanaryStopState, CANARY_HOST, CANARY_SENDER, createCanaryProof, verifyCanaryProof } from "./canary-runtime-proof";

const workflow = () => fs.readFileSync(".github/workflows/canary-sequences.yml", "utf8");

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("keeps the PAT out of runner steps and grants the job token Actions read", () => {
  const yaml = workflow();
  expect(yaml).toMatch(/permissions:\n  actions: read/);
  expect(yaml).toContain("GITHUB_TOKEN: ${{ github.token }}");
  expect(yaml).not.toMatch(/secrets\.CANARY_GITHUB_READ_TOKEN|gh api .*actions\/variables/);
  expect(fs.readFileSync("scripts/check-sequence-canary-failure-latch.ts", "utf8"))
    .not.toContain("process.env.CANARY_GITHUB_READ_TOKEN");
});

it("retains the job-level skip gate and rechecks the DB twice for full runs", () => {
  const yaml = workflow();
  expect(yaml).toContain("vars.SEQUENCE_CANARY_SCHEDULE_ENABLED == 'true'");
  expect(yaml.match(/npx tsx scripts\/check-sequence-canary-control\.ts/g)).toHaveLength(2);
  expect(yaml.indexOf("Check fresh canary authorization")).toBeLessThan(yaml.indexOf("Run Sequences V1 prod canary"));
  expect(yaml.indexOf("Recheck current canary authorization")).toBeLessThan(yaml.indexOf("Check prior full-run failure latch"));
  expect(fs.readFileSync("src/lib/sequences/canary-runtime-proof.ts", "utf8")).not.toContain("/actions/variables/");
  expect(fs.readFileSync("src/lib/sequences/canary-failure-latch.ts", "utf8")).not.toContain("/actions/variables/");
});

it("reads every control afresh and fails closed on a missing row or DB error", async () => {
  let value = "true";
  let error: Error | null = null;
  const query = vi.fn(async () => ({ data: value === "missing" ? null : { value }, error }));
  const client = { from: () => ({ select: () => ({ eq: () => ({ single: query }) }) }) } as never;
  await expect(readCanaryControl(client, "SEQUENCE_CANARY_SCHEDULE_ENABLED")).resolves.toBe("true");
  value = "false";
  await expect(readCanaryControl(client, "SEQUENCE_CANARY_SCHEDULE_ENABLED")).resolves.toBe("false");
  expect(query).toHaveBeenCalledTimes(2);
  value = "missing";
  await expect(readCanaryControl(client, "SEQUENCE_CANARY_SCHEDULE_ENABLED")).rejects.toThrow(/unavailable/);
  value = "true";
  error = new Error("DB offline");
  await expect(readCanaryControl(client, "SEQUENCE_CANARY_SCHEDULE_ENABLED")).rejects.toThrow(/unavailable/);
});

it("honors a mid-run control change at the dispatch guard", async () => {
  vi.stubEnv("SENDILLO_API_KEY", "test-key");
  vi.stubEnv("SENDILLO_FROM_NUMBER", CANARY_SENDER);
  vi.stubEnv("SENDILLO_WEBHOOK_SECRET", "webhook-key");
  vi.stubEnv("MESSAGING_PROVIDER", "sendillo");
  vi.stubEnv("TEST_SUPABASE_URL", `https://${CANARY_HOST}`);
  vi.stubEnv("VERCEL_DEPLOYMENT_ID", "dpl_test");
  vi.stubEnv("VERCEL_GIT_COMMIT_SHA", "a".repeat(40));
  vi.stubEnv("VERCEL_PROJECT_PRODUCTION_URL", "sandra.example.test");
  vi.stubEnv("CANARY_GITHUB_READ_TOKEN", "app-actions-token");
  const proof = verifyCanaryProof(createCanaryProof({ deploymentId: "dpl_test", commitSha: "a".repeat(40),
    supabaseHost: CANARY_HOST, aliasHost: "sandra.example.test", sender: CANARY_SENDER, provider: "sendillo",
    sequenceId: "11111111-1111-4111-8111-111111111111", runId: "12345", runMode: "scheduled",
    latestSendAt: Date.now() + 60_000, expiresAt: Date.now() + 60_000 }, "test-key"));
  let control = "true";
  const client = { from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: { value: control }, error: null }) }) }) }) } as never;
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/actions/runs/12345")
    ? { status: "in_progress", run_attempt: 1, event: "schedule" }
    : { workflow_runs: [], total_count: 0 })));
  vi.stubGlobal("fetch", fetchMock);
  await expect(assertCanaryStopState(proof, client)).resolves.toBeUndefined();
  control = "false";
  await expect(assertCanaryStopState(proof, client)).rejects.toThrow(/stop state/);
  expect(fetchMock.mock.calls.every(([url]) => !url.includes("/actions/variables"))).toBe(true);
});
