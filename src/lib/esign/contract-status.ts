import { ESIGN_STATUSES, type EsignStatus } from "./contracts";

export type ContractStatus = EsignStatus;

const CONTRACT_STATUS_SET = new Set<string>(ESIGN_STATUSES);

export function isContractStatus(value: unknown): value is ContractStatus {
  return typeof value === "string" && CONTRACT_STATUS_SET.has(value);
}

const POSTGRES_TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

function postgresTimestampMicros(value: string): bigint | null {
  const match = POSTGRES_TIMESTAMP_PATTERN.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (daysInMonth[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  const milliseconds = Date.parse(
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}${match[8]}`,
  );
  if (!Number.isFinite(milliseconds)) return null;

  const fractionalMicros = BigInt((match[7] ?? "").padEnd(6, "0"));
  return BigInt(milliseconds) * BigInt(1_000) + fractionalMicros;
}

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
  let latestCreatedAt: bigint | null = null;

  for (const contract of contracts) {
    const createdAt = postgresTimestampMicros(contract.created_at);
    if (createdAt === null) {
      throw new RangeError("Contract created_at must be a PostgreSQL timestamp");
    }
    if (
      latest === null ||
      latestCreatedAt === null ||
      createdAt > latestCreatedAt ||
      (createdAt === latestCreatedAt && contract.id > latest.id)
    ) {
      latest = contract;
      latestCreatedAt = createdAt;
    }
  }

  return latest;
}
