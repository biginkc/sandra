import { getCoachSectionById } from "./section-manifest";
import { CLOSR_SCRIPT } from "./script-block";
import type { CoachCallContext, CoachToken } from "./types";

export const SETUP_FIELDS = [
  ["seller_name", "Homeowner’s name", "basics"],
  ["rep_name", "Rep’s name", "basics"],
  ["property_address", "Property address", "basics"],
  ["rep_phone", "Rep’s callback number", "basics"],
  ["cold_caller_name", "Assistant’s name", "basics"],
  ["year_built", "Year built", "basics"],
  ["motivation", "Reason for selling", "situation"],
  ["dream_outcome", "Desired outcome", "situation"],
  ["offer_price", "Offer amount", "offer"],
  ["net_to_seller", "Net proceeds", "offer"],
  ["closing_date", "Closing date", "offer"],
] as const satisfies readonly (readonly [
  Exclude<CoachToken, "file_number">,
  string,
  string,
])[];
export type SetupField = (typeof SETUP_FIELDS)[number][0];
export type SetupEdits = Partial<Record<SetupField, string>>;
export const SETUP_SELECTORS = [
  { key: "Opener", label: "Opener", phase: "introduction" },
  { key: "Entry", label: "Occupancy", phase: "reveal" },
  {
    key: "Example probes — goal 7+",
    label: "Discovery questions",
    phase: "reveal",
  },
  { key: "Motivation", label: "Motivation", phase: "reveal" },
  { key: "offer.outcome-tracks", label: "Offer outcome", phase: "offer" },
  { key: "close.decision-tracks", label: "Closing path", phase: "close" },
] as const;
export type SetupSelector = (typeof SETUP_SELECTORS)[number]["key"];
export type SetupBranches = Partial<Record<SetupSelector, string>>;
export type SetupDraft = {
  version: 1;
  edits: SetupEdits;
  branches: SetupBranches;
};
/** Authenticated identity is deliberately separate from editable spoken fields. */
export type PreparedCoachSetup = SetupDraft & {
  operatorId: string | null;
  targetKey: string;
  propertyId: string | null;
  phoneE164: string;
  context: CoachCallContext;
};
export const EMPTY_SETUP: SetupDraft = { version: 1, edits: {}, branches: {} };
export function setupOptions(key: SetupSelector) {
  const selector = SETUP_SELECTORS.find((item) => item.key === key)!;
  const branches = CLOSR_SCRIPT.phases.find(
    (phase) => phase.id === selector.phase,
  )!.display.branches;
  if (key.includes("."))
    return getCoachSectionById(
      key as "offer.outcome-tracks" | "close.decision-tracks",
    )!.content.map((ref) => ({ value: ref.branch_tag, label: ref.branch_tag }));
  return branches
    .find((branch) => branch.tag === key)!
    .variants.map((variant) => ({
      value: variant.key,
      label:
        key === "Example probes — goal 7+" && variant.key === "vacant"
          ? "Vacant property"
          : (variant.label ??
            (variant.key === "unknown" ? "Unknown" : variant.key)),
    }));
}
export function setupDefaults(context: CoachCallContext): SetupBranches {
  const source: Record<string, string> = {
    cold_call: "cold_call",
    sms: "sms",
    driving_for_dollars: "d4d",
    fsbo: "fsbo",
  };
  const discovery: Record<string, string> = {
    owner_occupied: "homeowner",
    tenant_occupied: "investor",
    vacant: "vacant",
  };
  return {
    Opener: source[context.leadSource ?? ""] ?? "cold_call",
    Entry: context.occupancy ?? "unknown",
    ...(context.occupancy && discovery[context.occupancy]
      ? { "Example probes — goal 7+": discovery[context.occupancy] }
      : {}),
  };
}
export function setupValues(
  context: CoachCallContext | null,
  edits: SetupEdits,
): Record<SetupField, string> {
  return {
    seller_name: context?.sellerName ?? "",
    rep_name: context?.repName ?? "",
    property_address: context?.propertyAddress ?? "",
    rep_phone: context?.repPhoneE164 ?? "",
    cold_caller_name: context?.coldCallerName ?? "Mel",
    year_built: context?.yearBuilt ?? "",
    motivation: context?.motivation ?? "",
    dream_outcome: "",
    offer_price: "",
    net_to_seller: "",
    closing_date: "",
    ...edits,
  };
}
export function parseSetupDraft(raw: string | null): SetupDraft {
  try {
    const value = JSON.parse(raw ?? "null");
    if (!value || value.version !== 1 || !value.edits || !value.branches)
      return structuredClone(EMPTY_SETUP);
    const edits: SetupEdits = {},
      branches: SetupBranches = {};
    for (const [key] of SETUP_FIELDS)
      if (
        Object.hasOwn(value.edits, key) &&
        typeof value.edits[key] === "string"
      )
        edits[key] = value.edits[key].slice(
          0,
          key === "motivation" || key === "dream_outcome" ? 2000 : 500,
        );
    for (const { key } of SETUP_SELECTORS)
      if (
        setupOptions(key).some((option) => option.value === value.branches[key])
      )
        branches[key] = value.branches[key];
    return { version: 1, edits, branches };
  } catch {
    return structuredClone(EMPTY_SETUP);
  }
}
const SETUP_STORAGE_PREFIX = "sandra.coach.setup.v1:";
export function setupStorageKey(operatorId: string, targetKey: string) {
  return `${SETUP_STORAGE_PREFIX}${operatorId}:${targetKey}`;
}
export function clearSetupDrafts(operatorId: string, storage: Storage) {
  const prefix = `${SETUP_STORAGE_PREFIX}${operatorId}:`;
  try {
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  } catch {
    /* Storage is optional. */
  }
}
