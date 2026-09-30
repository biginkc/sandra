import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";
import { assertNoUnacknowledgedCanaryFailure } from "./canary-failure-latch";

export const CANARY_PROOF_PREFIX = "CANARY_RUNTIME_PROOF_V1:";
export const CANARY_PROOF_TTL_MS = 20 * 60_000;
export const CANARY_HOST = "copflsklaefwzipsrjqz.supabase.co";
export const CANARY_SENDER = "+18164876899";

export type CanaryProof = {
  version: 1;
  deploymentId: string;
  commitSha: string;
  supabaseHost: string;
  aliasHost: string;
  sender: string;
  provider: "sendillo";
  sequenceId: string;
  runId: string;
  runMode: "scheduled" | "manual";
  latestSendAt: number;
  expiresAt: number;
  signature: string;
};

export function effectiveSupabaseHost(): string {
  const useTestEnv = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const url = useTestEnv
    ? process.env.TEST_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL
    : process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    return url ? new URL(url).hostname : "";
  } catch {
    return "";
  }
}

export function deploymentIdentity() {
  return {
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID?.trim() ?? "",
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA?.trim() ?? "",
  };
}

export function runtimeSnapshot(nonce: string) {
  const key = process.env.SENDILLO_API_KEY ?? "";
  const sender = process.env.SENDILLO_FROM_NUMBER ?? "";
  return {
    providerIsSendillo: process.env.MESSAGING_PROVIDER?.trim().toLowerCase() === "sendillo",
    senderMatches: sender === CANARY_SENDER,
    senderLast4: sender.slice(-4),
    webhookSecretPresent: Boolean(process.env.SENDILLO_WEBHOOK_SECRET?.trim()),
    supabaseHost: effectiveSupabaseHost(),
    hmac: key ? createHmac("sha256", key).update(nonce).digest("hex") : "",
    ...deploymentIdentity(),
  };
}

function signedFields(proof: Omit<CanaryProof, "signature">): string {
  return JSON.stringify([
    proof.version, proof.deploymentId, proof.commitSha, proof.supabaseHost,
    proof.aliasHost, proof.sender, proof.provider, proof.sequenceId,
    proof.runId, proof.runMode, proof.latestSendAt, proof.expiresAt,
  ]);
}

export function createCanaryProof(
  input: Omit<CanaryProof, "version" | "signature">,
  key: string,
): string {
  if (!key) throw new Error("Canary key missing");
  const fields = { version: 1 as const, ...input };
  const signature = createHmac("sha256", key).update(signedFields(fields)).digest("hex");
  return CANARY_PROOF_PREFIX + JSON.stringify({ ...fields, signature });
}

export function verifyCanaryProof(description: string | null, now = Date.now()): CanaryProof {
  if (!description?.startsWith(CANARY_PROOF_PREFIX)) throw new Error("Canary runtime proof missing");
  let proof: CanaryProof;
  try {
    proof = JSON.parse(description.slice(CANARY_PROOF_PREFIX.length)) as CanaryProof;
  } catch {
    throw new Error("Canary runtime proof invalid");
  }
  const key = process.env.SENDILLO_API_KEY ?? "";
  const identity = deploymentIdentity();
  if (!key || proof.version !== 1 || !Number.isFinite(proof.expiresAt) ||
      proof.expiresAt <= now || proof.expiresAt > now + CANARY_PROOF_TTL_MS ||
      !identity.deploymentId || !/^[0-9a-f]{40}$/i.test(identity.commitSha) ||
      proof.deploymentId !== identity.deploymentId || proof.commitSha !== identity.commitSha ||
      proof.supabaseHost !== CANARY_HOST || proof.supabaseHost !== effectiveSupabaseHost() ||
      proof.sender !== CANARY_SENDER || proof.sender !== process.env.SENDILLO_FROM_NUMBER ||
      proof.provider !== "sendillo" || process.env.MESSAGING_PROVIDER?.trim().toLowerCase() !== "sendillo" ||
      !process.env.SENDILLO_WEBHOOK_SECRET?.trim() ||
      !proof.aliasHost || proof.aliasHost !== process.env.VERCEL_PROJECT_PRODUCTION_URL ||
      !/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(proof.sequenceId ?? "") ||
      !/^\d+$/.test(proof.runId ?? "") ||
      !["scheduled", "manual"].includes(proof.runMode) ||
      !Number.isFinite(proof.latestSendAt) || proof.latestSendAt <= now ||
      proof.latestSendAt > proof.expiresAt ||
      !/^[0-9a-f]{64}$/i.test(proof.signature ?? "")) {
    throw new Error("Canary runtime proof configuration mismatch or expired");
  }
  const { signature, ...fields } = proof;
  const expected = createHmac("sha256", key).update(signedFields(fields)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) {
    throw new Error("Canary runtime proof key mismatch");
  }
  return proof;
}

export async function assertCanaryAlias(proof: CanaryProof): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`https://${proof.aliasHost}/api/internal/canary/deployment-identity`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || response.headers.get("cache-control")?.toLowerCase() !== "no-store") {
      throw new Error("alias unavailable");
    }
    const identity = await response.json() as ReturnType<typeof deploymentIdentity>;
    if (identity.deploymentId !== proof.deploymentId || identity.commitSha !== proof.commitSha) {
      throw new Error("alias deployment mismatch");
    }
  } catch {
    throw new Error("Canary production alias could not be bound to inspected deployment");
  }
}

export async function assertCanaryStopState(proof: CanaryProof): Promise<void> {
  const token = process.env.CANARY_GITHUB_READ_TOKEN;
  if (!token) throw new Error("Canary stop-state read token missing");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
  };
  const variable = proof.runMode === "scheduled"
    ? "SEQUENCE_CANARY_SCHEDULE_ENABLED"
    : "SEQUENCE_CANARY_MANUAL_RUN_ID";
  try {
    const [flag, run] = await Promise.all([
      fetch(`https://api.github.com/repos/biginkc/sandra/actions/variables/${variable}`, {
        headers, cache: "no-store", signal: AbortSignal.timeout(5000),
      }),
      fetch(`https://api.github.com/repos/biginkc/sandra/actions/runs/${proof.runId}`, {
        headers, cache: "no-store", signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (!flag.ok || !run.ok) throw new Error("GitHub state unavailable");
    const flagBody = await flag.json() as { value?: string };
    const runBody = await run.json() as { status?: string; run_attempt?: number; event?: string };
    const expectedValue = proof.runMode === "scheduled" ? "true" : proof.runId;
    const expectedEvent = proof.runMode === "scheduled" ? "schedule" : "workflow_dispatch";
    if (flagBody.value !== expectedValue || runBody.status !== "in_progress" ||
        runBody.run_attempt !== 1 || runBody.event !== expectedEvent) {
      throw new Error("Canary stopped or unauthorized");
    }
    await assertNoUnacknowledgedCanaryFailure(proof.runId, token);
  } catch {
    throw new Error("Canary stop state could not be verified");
  }
}

/** The dedicated fixture cannot dispatch without the runner's signed proof. */
export async function assertCanarySendBinding(
  client: SupabaseClient<Database>,
  input: { propertyId: string | null; body: string; enrollmentId?: string },
): Promise<void> {
  if (input.propertyId !== process.env.SEQUENCE_CANARY_PROPERTY_ID &&
      !input.body.includes("PROD-SMOKE")) return;
  if (!input.enrollmentId || !input.propertyId ||
      input.propertyId !== process.env.SEQUENCE_CANARY_PROPERTY_ID ||
      !input.body.includes("PROD-SMOKE")) {
    throw new Error("Canary send requires a bound sequence enrollment");
  }
  const { data: enrollment, error: enrollmentError } = await client
    .from("sequence_enrollments")
    .select("sequence_id,property_id,contact_id")
    .eq("id", input.enrollmentId)
    .single();
  if (enrollmentError || !enrollment ||
      enrollment.property_id !== input.propertyId ||
      enrollment.contact_id !== process.env.SEQUENCE_CANARY_CONTACT_ID) {
    throw new Error("Canary enrollment binding mismatch");
  }
  const { data: sequence, error: sequenceError } = await client
    .from("sequences")
    .select("description,created_by")
    .eq("id", enrollment.sequence_id)
    .single();
  if (sequenceError || !sequence ||
      sequence.created_by !== process.env.SEQUENCE_CANARY_USER_ID) {
    throw new Error("Canary sequence ownership mismatch");
  }
  const proof = verifyCanaryProof(sequence.description);
  if (proof.sequenceId !== enrollment.sequence_id) {
    throw new Error("Canary runtime proof sequence mismatch");
  }
  await assertCanaryStopState(proof);
  await assertCanaryAlias(proof);
  // Re-read process configuration after the network checks, directly at the
  // provider boundary. A changed key, sender, DB target, or deployment fails.
  verifyCanaryProof(sequence.description);
}
