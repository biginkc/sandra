export const CONTRACT_STATUSES = [
  "awaiting",
  "viewed",
  "signed",
  "declined",
  "voided",
  "error",
] as const;

export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export interface ContractStatusRecord {
  id: string;
  created_at: string;
  status: ContractStatus;
}

/**
 * Selects the latest local contract without mutating the supplied collection.
 * Database callers must request the same ordering: created_at DESC, id DESC.
 */
export function selectLatestContract<T extends ContractStatusRecord>(
  contracts: readonly T[],
): T | null {
  let latest: T | null = null;

  for (const contract of contracts) {
    if (
      latest === null ||
      contract.created_at > latest.created_at ||
      (contract.created_at === latest.created_at && contract.id > latest.id)
    ) {
      latest = contract;
    }
  }

  return latest;
}
