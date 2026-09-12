import { precallProfiles } from "./precall-profiles";
let selected = 0;
let contextMode: "ready" | "deferred" | "failed" = "ready";
const waiting: (() => void)[] = [];
export const matrixFaults = {
  setContextMode(mode: typeof contextMode) {
    contextMode = mode;
  },
  resolveNewest() {
    waiting.pop()?.();
  },
  resolveRemaining() {
    for (const resolve of waiting.splice(0)) resolve();
  },
  get pending() {
    return waiting.length;
  },
};
export const matrixEvidence = { inspections: 0, starts: 0, dispositions: 0 };
export function chooseProfile(index: number) {
  selected = index;
}
function profile(input?: {
  propertyId?: string | null;
  sellerPhoneE164?: string | null;
}) {
  return (
    precallProfiles.find((p) =>
      input?.propertyId
        ? p.target.propertyId === input.propertyId
        : input?.sellerPhoneE164
          ? p.target.phoneE164 === input.sellerPhoneE164
          : false,
    ) ?? precallProfiles[selected]
  );
}
export async function loadPrecallContext(input: Parameters<typeof profile>[0]) {
  const p = profile(input);
  if (contextMode === "failed")
    throw new Error("Injected pre-call read failure");
  const result = { operatorId: p.operatorId, context: p.context, error: null };
  if (contextMode === "deferred")
    return new Promise<typeof result>((resolve) =>
      waiting.push(() => resolve(result)),
    );
  return result;
}
export async function loadCoachCallContext(
  input: Parameters<typeof profile>[0],
) {
  return profile(input).context;
}
export async function inspectLeadCall(id: string) {
  matrixEvidence.inspections++;
  return { ok: true as const, data: profile({ propertyId: id }).target };
}
export async function inspectManualCall(phone: string) {
  matrixEvidence.inspections++;
  return {
    ok: true as const,
    data: profile({
      sellerPhoneE164: phone.startsWith("+") ? phone : `+1${phone}`,
    }).target,
  };
}
export async function prepareLeadCall(id: string) {
  matrixEvidence.starts++;
  return { ok: true as const, data: profile({ propertyId: id }).target };
}
export async function prepareManualCall(phone: string) {
  matrixEvidence.starts++;
  return {
    ok: true as const,
    data: profile({
      sellerPhoneE164: phone.startsWith("+") ? phone : `+1${phone}`,
    }).target,
  };
}
export async function prepareSetupCall(input: {
  propertyId: string | null;
  phoneE164: string;
}) {
  return input.propertyId
    ? prepareLeadCall(input.propertyId)
    : prepareManualCall(input.phoneE164);
}
export const loadDialerRecents = async () => ({
  ok: true as const,
  data: precallProfiles.map((p) => ({
    ...p.target,
    createdAt: "2026-09-10T12:00:00Z",
  })),
});
export const searchDialerLeads = async () => ({ ok: true as const, data: [] });
export const completeSoftphoneCall = async () => {
  matrixEvidence.dispositions++;
  return { ok: true as const, data: {} };
};
export const resumeFailedSoftphoneCall = async () => ({
  ok: true as const,
  data: {},
});
