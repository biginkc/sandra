/** Browser/workflow-safe constants for the reviewed dataset contract. */
export const REVIEWED_DATASET_VERSION = 2;
export const GENERATED_DNC_HEADER = "__sandra_dnc_locked";

export type ReviewContractInput = {
  datasetSha256: string;
  mapping: Readonly<Record<string, string | null>>;
  source: string;
  countyId: string;
  totalRows: number;
  dncRows: number;
  smsConsent: boolean;
  sequenceId: string | null;
  classifyLineTypes: boolean;
  requestCass: boolean;
  requestSkipTrace: boolean;
};

/** Canonical JSON whose hash binds reviewed bytes to their interpretation. */
export function reviewContractJson(input: ReviewContractInput): string {
  const mapping = Object.fromEntries(
    Object.entries(input.mapping).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify({
    version: REVIEWED_DATASET_VERSION,
    datasetSha256: input.datasetSha256,
    mapping,
    source: input.source,
    countyId: input.countyId,
    totalRows: input.totalRows,
    dncRows: input.dncRows,
    smsConsent: input.smsConsent,
    sequenceId: input.sequenceId,
    classifyLineTypes: input.classifyLineTypes,
    requestCass: input.requestCass,
    requestSkipTrace: input.requestSkipTrace,
  });
}
