import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";

import {
  CANARY_HOST, CANARY_PROOF_TTL_MS, CANARY_SENDER, createCanaryProof,
  type CanaryProof,
} from "../src/lib/sequences/canary-runtime-proof";

export type RuntimeProofInput = {
  approvedKey: string;
  adminAccessToken: string;
  deploymentUrl: string;
  aliasHost: string;
  expectedCommitSha: string;
  sequenceId: string;
  runId: string;
  runMode: "scheduled" | "manual";
};

type RuntimeResponse = {
  providerIsSendillo: boolean;
  senderMatches: boolean;
  senderLast4: string;
  webhookSecretPresent: boolean;
  supabaseHost: string;
  hmac: string;
  deploymentId: string;
  commitSha: string;
};

/** A queued or delayed scheduled run may not turn into a catch-up send. */
export function scheduledSendDeadline(now = Date.now()): number {
  const current = new Date(now);
  const day = current.getUTCDay();
  const due = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(), 14, 17);
  const deadline = due + 10 * 60_000;
  if (day < 1 || day > 5 || now < due || now > deadline) {
    throw new Error("Scheduled canary send window elapsed");
  }
  return deadline;
}

function vercelCurl(path: string, deploymentUrl: string, extra: string[] = []): { body: unknown; noStore: boolean } {
  // The access token stays in the child argv, never the job log. Vercel CLI
  // supplies only deployment-protection bypass; Sandra authorization is separate.
  let raw: string;
  try {
    raw = execFileSync("vercel", [
      "curl", path, "--deployment", deploymentUrl, "--", "-sS", "-D", "-",
      ...extra,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20_000 });
  } catch {
    throw new Error("Canary Vercel request failed");
  }
  const split = raw.lastIndexOf("\r\n\r\n") >= 0 ? "\r\n\r\n" : "\n\n";
  const index = raw.lastIndexOf(split);
  if (index < 0) throw new Error("Canary proof HTTP response invalid");
  const allHeaders = raw.slice(0, index);
  const finalHeaderStart = Math.max(0, allHeaders.lastIndexOf("\nHTTP/"));
  const headerText = allHeaders.slice(finalHeaderStart).trim().toLowerCase();
  if (!/^http\/\S+ 200\b/.test(headerText)) throw new Error("Canary proof HTTP status mismatch");
  const bodyText = raw.slice(index + split.length);
  try {
    return {
      body: JSON.parse(bodyText) as unknown,
      noStore: /^cache-control:\s*no-store\s*$/im.test(headerText),
    };
  } catch {
    throw new Error("Canary proof JSON invalid");
  }
}

export function assertRuntimeResponse(
  response: RuntimeResponse,
  nonce: string,
  input: RuntimeProofInput,
  aliasDeploymentId: string,
): string {
  const expected = createHmac("sha256", input.approvedKey).update(nonce).digest();
  if (!/^[0-9a-f]{64}$/i.test(response.hmac ?? "") ||
      !timingSafeEqual(expected, Buffer.from(response.hmac, "hex"))) {
    throw new Error("Canary approved key mismatch");
  }
  if (!response.providerIsSendillo || !response.senderMatches ||
      response.senderLast4 !== "6899" || !response.webhookSecretPresent ||
      response.supabaseHost !== CANARY_HOST ||
      !response.deploymentId || response.deploymentId !== aliasDeploymentId ||
      !/^[0-9a-f]{40}$/i.test(response.commitSha) ||
      response.commitSha !== input.expectedCommitSha) {
    throw new Error("Canary runtime configuration or deployment mismatch");
  }
  const proof: Omit<CanaryProof, "version" | "signature"> = {
    deploymentId: response.deploymentId,
    commitSha: response.commitSha,
    supabaseHost: response.supabaseHost,
    aliasHost: input.aliasHost,
    sender: CANARY_SENDER,
    provider: "sendillo",
    sequenceId: input.sequenceId,
    runId: input.runId,
    runMode: input.runMode,
    latestSendAt: input.runMode === "scheduled" ? scheduledSendDeadline() : Date.now() + CANARY_PROOF_TTL_MS,
    expiresAt: Date.now() + CANARY_PROOF_TTL_MS,
  };
  return createCanaryProof(proof, input.approvedKey);
}

export function inspectRuntime(input: RuntimeProofInput): { description: string; deploymentId: string; commitSha: string } {
  if (!input.approvedKey || !input.adminAccessToken ||
      !/^https:\/\/[a-z0-9.-]+$/i.test(input.deploymentUrl) ||
      !/^[a-z0-9.-]+$/i.test(input.aliasHost) ||
      !/^[0-9a-f]{40}$/i.test(input.expectedCommitSha) ||
      !/^\d+$/.test(input.runId)) {
    throw new Error("Canary runtime proof inputs missing or invalid");
  }
  if (input.runMode === "scheduled") scheduledSendDeadline();
  const alias = vercelCurl("/api/internal/canary/deployment-identity", `https://${input.aliasHost}`);
  const aliasBody = alias.body as { deploymentId?: string; commitSha?: string };
  if (!alias.noStore || !aliasBody?.deploymentId || aliasBody.commitSha !== input.expectedCommitSha) {
    throw new Error("Canary production alias deployment mismatch");
  }
  const nonce = randomBytes(32).toString("hex");
  const proof = vercelCurl("/api/internal/canary/runtime-proof", input.deploymentUrl, [
    "-X", "POST",
    "-H", `Authorization: Bearer ${input.adminAccessToken}`,
    "-H", "Content-Type: application/json",
    "--data", JSON.stringify({ nonce }),
  ]);
  if (!proof.noStore) throw new Error("Canary runtime proof was cacheable");
  const body = proof.body as RuntimeResponse;
  const description = assertRuntimeResponse(body, nonce, input, aliasBody.deploymentId);
  console.log("[runtime-proof]", JSON.stringify({
    providerMatches: true, senderMatches: true, senderLast4: "6899",
    webhookSecretPresent: true, supabaseHostMatches: true, keyMatches: true,
    deploymentId: body.deploymentId, commitSha: body.commitSha,
  }));
  return { description, deploymentId: body.deploymentId, commitSha: body.commitSha };
}
