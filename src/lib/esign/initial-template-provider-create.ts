import type { TemplateActionResult } from "./template-orchestrator";
import { classifyProviderFailure } from "./provider-failure";

export type ProviderCreateState =
  "unstarted" | "claimed" | "invoking" | "unknown" | "attached";

export type InitialProviderEditorSession = Readonly<{
  providerTemplateId: string;
  editUrl: string;
  expiresAt: number | null;
  clientId: string;
}>;

export type InitialProviderCreatePorts = Readonly<{
  claim(input: {
    orgId: string;
    templateId: string;
    sourceId: string;
    actorId: string;
  }): Promise<{
    outcome: "claimed" | "already_in_progress" | "already_attached";
    templateId: string;
    providerCreateState: ProviderCreateState;
    claimToken: string | null;
    providerTemplateId: string | null;
    providerAccountId: string | null;
    createdBy: string;
  }>;
  begin(input: {
    orgId: string;
    templateId: string;
    sourceId: string;
    claimToken: string;
    actorId: string;
  }): Promise<{
    outcome: "started" | "already_started" | "already_attached";
    templateId: string;
    providerCreateState: ProviderCreateState;
    createdBy: string;
  }>;
  release(input: {
    orgId: string;
    templateId: string;
    sourceId: string;
    claimToken: string;
    actorId: string;
  }): Promise<{
    outcome: "released" | "already_released" | "already_attached";
    templateId: string;
    createdBy: string;
  }>;
  markUnknown(input: {
    orgId: string;
    templateId: string;
    sourceId: string;
    claimToken: string;
    errorCode: string;
    actorId: string;
  }): Promise<{
    outcome: "recorded_unknown" | "already_unknown" | "already_attached";
    templateId: string;
    createdBy: string;
  }>;
  recordDefinitiveFailure(input: {
    orgId: string;
    templateId: string;
    sourceId: string;
    claimToken: string;
    errorCode: string;
    actorId: string;
  }): Promise<{
    outcome: "recorded_failure" | "already_recorded" | "already_attached";
    templateId: string;
    createdBy: string;
  }>;
  complete(input: {
    orgId: string;
    templateId: string;
    sourceId: string;
    claimToken: string;
    providerTemplateId: string;
    providerAccountId: string;
    actorId: string;
  }): Promise<{
    outcome: "attached" | "already_attached";
    templateId: string;
    providerTemplateId: string;
    createdBy: string;
  }>;
  provider: {
    loadAccountIdentity(): Promise<{ providerAccountId: string }>;
    invoke(): Promise<InitialProviderEditorSession>;
  };
}>;

export async function runInitialProviderCreate(
  input: Readonly<{
    orgId: string;
    templateId: string;
    sourceId: string;
    actorId: string;
  }>,
  ports: InitialProviderCreatePorts,
): Promise<
  TemplateActionResult<{
    templateId: string;
    providerTemplateId: string;
    initialEditorSession: InitialProviderEditorSession | null;
  }>
> {
  let claim: Awaited<ReturnType<InitialProviderCreatePorts["claim"]>>;
  try {
    claim = await ports.claim(input);
  } catch {
    return failure(
      "PROVIDER_CREATE_CLAIM_FAILED",
      "The hidden template draft could not claim provider creation.",
    );
  }
  if (claim.templateId !== input.templateId)
    return failure(
      "PROVIDER_CREATE_CLAIM_MISMATCH",
      "The provider creation claim did not match the hidden draft.",
    );
  if (claim.outcome === "already_attached") {
    return claim.providerCreateState === "attached" && claim.providerTemplateId
      ? success({
          templateId: claim.templateId,
          providerTemplateId: claim.providerTemplateId,
          initialEditorSession: null,
        })
      : failure(
          "PROVIDER_CREATE_CLAIM_MISMATCH",
          "The attached provider template could not be reconciled.",
        );
  }
  if (claim.outcome === "already_in_progress") {
    return failure(
      "PROVIDER_CREATE_IN_PROGRESS",
      "Provider creation is already in progress and remains available for recovery.",
    );
  }
  if (
    claim.providerCreateState !== "claimed" ||
    !claim.claimToken ||
    !claim.providerAccountId
  ) {
    return failure(
      "PROVIDER_CREATE_CLAIM_MISMATCH",
      "The provider creation claim was invalid.",
    );
  }
  const claimed = { ...input, claimToken: claim.claimToken };
  let loadedProviderAccountId: string;
  try {
    ({ providerAccountId: loadedProviderAccountId } =
      await ports.provider.loadAccountIdentity());
  } catch {
    try {
      await ports.release(claimed);
    } catch {
      /* Explicit failure below; the durable claim remains visible. */
    }
    return failure(
      "PROVIDER_CONFIGURATION_FAILED",
      "Dropbox Sign is not connected. The hidden draft was not sent to the provider.",
    );
  }
  if (
    !loadedProviderAccountId ||
    loadedProviderAccountId !== claim.providerAccountId
  ) {
    try {
      await ports.release(claimed);
    } catch {
      /* The durable claim remains visible when release cannot be proven. */
    }
    return failure(
      "PROVIDER_ACCOUNT_MISMATCH",
      "Dropbox Sign changed before provider creation could begin.",
    );
  }
  let begun: Awaited<ReturnType<InitialProviderCreatePorts["begin"]>>;
  try {
    begun = await ports.begin(claimed);
  } catch {
    return failure(
      "PROVIDER_CREATE_BEGIN_FAILED",
      "Provider creation could not be started safely.",
    );
  }
  if (begun.outcome === "already_attached") {
    return failure(
      "PROVIDER_CREATE_RECONCILE_REQUIRED",
      "The attached provider template must be reconciled from durable state.",
    );
  }
  if (begun.outcome !== "started" || begun.providerCreateState !== "invoking") {
    return failure(
      "PROVIDER_CREATE_IN_PROGRESS",
      "Provider creation is already in progress and will not be repeated.",
    );
  }
  let initialEditorSession: InitialProviderEditorSession;
  try {
    initialEditorSession = await ports.provider.invoke();
  } catch (error) {
    if (classifyProviderFailure(error) === "definitive_failure") {
      try {
        const recorded = await ports.recordDefinitiveFailure({
          ...claimed,
          errorCode: "PROVIDER_REQUEST_REJECTED",
        });
        if (
          recorded.templateId === input.templateId &&
          ["recorded_failure", "already_recorded"].includes(recorded.outcome)
        ) {
          return failure(
            "PROVIDER_CREATE_REJECTED",
            "Dropbox Sign rejected the template create request before creating a template. The draft remains retryable.",
          );
        }
      } catch {
        // The provider definitively rejected the request, but durable retry
        // state could not be proven. Keep the invoking fence intact.
      }
      return failure(
        "PROVIDER_CREATE_FAILURE_RECORD_FAILED",
        "Dropbox Sign rejected the template create request, but Sandra could not restore safe retry state.",
      );
    }
    await markUnknownBestEffort(ports, claimed, "PROVIDER_RESPONSE_UNKNOWN");
    return failure(
      "PROVIDER_CREATE_UNKNOWN",
      "Dropbox Sign may have created the template. Manual reconciliation is required.",
    );
  }
  const { providerTemplateId } = initialEditorSession;
  if (
    !providerTemplateId ||
    !initialEditorSession.editUrl ||
    !initialEditorSession.clientId
  ) {
    await markUnknownBestEffort(ports, claimed, "PROVIDER_ID_MISSING");
    return failure(
      "PROVIDER_CREATE_UNKNOWN",
      "Dropbox Sign did not return a template identifier. Manual reconciliation is required.",
    );
  }
  try {
    const completed = await ports.complete({
      ...claimed,
      providerTemplateId,
      providerAccountId: claim.providerAccountId,
    });
    if (
      completed.templateId !== input.templateId ||
      completed.providerTemplateId !== providerTemplateId
    ) {
      return failure(
        "PROVIDER_CREATE_COMPLETE_MISMATCH",
        "The provider template attachment could not be reconciled.",
      );
    }
    return success({
      templateId: completed.templateId,
      providerTemplateId: completed.providerTemplateId,
      initialEditorSession,
    });
  } catch {
    const unknown = await markUnknownBestEffort(
      ports,
      claimed,
      "PROVIDER_ATTACH_UNKNOWN",
    );
    if (unknown?.outcome === "already_attached") {
      try {
        const replay = await ports.claim(input);
        if (
          replay.outcome === "already_attached" &&
          replay.providerCreateState === "attached" &&
          replay.templateId === input.templateId &&
          replay.providerTemplateId === providerTemplateId &&
          replay.providerAccountId === claim.providerAccountId
        ) {
          return success({
            templateId: replay.templateId,
            providerTemplateId,
            initialEditorSession,
          });
        }
      } catch {
        // Fail closed below when the durable attachment cannot be proven.
      }
      return failure(
        "PROVIDER_CREATE_COMPLETE_MISMATCH",
        "The provider template attachment could not be reconciled.",
      );
    }
    return failure(
      "PROVIDER_CREATE_UNKNOWN",
      "The provider template requires manual reconciliation.",
    );
  }
}

async function markUnknownBestEffort(
  ports: InitialProviderCreatePorts,
  input: {
    orgId: string;
    templateId: string;
    sourceId: string;
    claimToken: string;
    actorId: string;
  },
  errorCode: string,
) {
  try {
    return await ports.markUnknown({ ...input, errorCode });
  } catch {
    return null;
  }
}

function success<T>(data: T): TemplateActionResult<T> {
  return { ok: true, data };
}
function failure(code: string, message: string): TemplateActionResult<never> {
  return { ok: false, error: { code, message } };
}
