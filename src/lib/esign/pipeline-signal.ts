import {
  isContractStatus,
  selectLatestContract,
  type ContractStatusRecord,
} from "./contract-status";

export const MAX_PIPELINE_SIGNAL_PROPERTIES = 50;
export const LATEST_ESIGN_REQUESTS_RPC =
  "get_latest_esign_requests_for_properties" as const;

export type LatestEsignRequestRpcRow = {
  org_id: string;
  property_id: string;
  id: string;
  created_at: string;
  status: ContractStatusRecord["status"];
};

export type PipelineSignalRequest = {
  orgId: string;
  propertyIds: readonly string[];
};

export type PipelineSignalRow = ContractStatusRecord & {
  org_id: string;
  property_id: string;
};

export type PipelineSignalLoader = (
  request: PipelineSignalRequest,
) => Promise<readonly PipelineSignalRow[]>;

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPipelineSignalRow(value: unknown): value is PipelineSignalRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<PipelineSignalRow>;
  return (
    isNonemptyString(row.id) &&
    isNonemptyString(row.org_id) &&
    isNonemptyString(row.property_id) &&
    isNonemptyString(row.created_at) &&
    isContractStatus(row.status)
  );
}

/**
 * Fail-soft adapter for the future bounded database loader. The loader must
 * enforce organization scope and return no more than one row per property.
 */
export async function loadPipelineSignals(
  loader: PipelineSignalLoader,
  request: PipelineSignalRequest,
): Promise<ReadonlyMap<string, PipelineSignalRow>> {
  const propertyIds = [...new Set(request.propertyIds)];
  if (propertyIds.length === 0) return new Map();
  if (propertyIds.length > MAX_PIPELINE_SIGNAL_PROPERTIES) {
    throw new RangeError(
      `Pipeline signal requests are limited to ${MAX_PIPELINE_SIGNAL_PROPERTIES} properties`,
    );
  }

  try {
    const requestedIds = new Set(propertyIds);
    const rows = await loader({ orgId: request.orgId, propertyIds });
    const rowsByProperty = new Map<string, PipelineSignalRow[]>();

    for (const row of rows) {
      if (!isPipelineSignalRow(row)) return new Map();
      if (row.org_id !== request.orgId) continue;
      if (!requestedIds.has(row.property_id)) continue;
      const propertyRows = rowsByProperty.get(row.property_id) ?? [];
      propertyRows.push(row);
      rowsByProperty.set(row.property_id, propertyRows);
    }

    const latestByProperty = new Map<string, PipelineSignalRow>();
    for (const [propertyId, propertyRows] of rowsByProperty) {
      const latest = selectLatestContract(propertyRows);
      if (latest) latestByProperty.set(propertyId, latest);
    }
    return latestByProperty;
  } catch {
    return new Map();
  }
}
