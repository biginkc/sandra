import { normalizeAddress } from "./normalize";
import { validateRow, type Mapping, type RowData } from "./validate";

export type PreflightProbe = {
  rowIndex: number;
  addressNormalized: string | null;
  phones: string[];
};

export type PreflightGroup =
  | "new"
  | "existing"
  | "blocked"
  | "warnings"
  | "dnc"
  | "duplicates"
  | "empty"
  | "malformed"
  | "noUsableContact";

export type ImportPreflight = {
  total: number;
  ready: number;
  existingMatches: number;
  inFileDuplicates: number;
  empty: number;
  malformed: number;
  noUsableContact: number;
  dnc: number;
  groups: Record<PreflightGroup, number[]>;
  dncReasons: Record<number, string[]>;
};

function emptyGroups(): Record<PreflightGroup, number[]> {
  return {
    new: [],
    existing: [],
    blocked: [],
    warnings: [],
    dnc: [],
    duplicates: [],
    empty: [],
    malformed: [],
    noUsableContact: [],
  };
}

function normalizedPhones(normalized: Readonly<Record<string, unknown>>): string[] {
  const phones = [1, 2, 3]
    .map((slot) => normalized[`homeowner_phone_${slot}`])
    .filter((phone): phone is string => typeof phone === "string" && phone.length > 0);
  const identityOnly = normalized.homeowner_dnc_phones;
  if (typeof identityOnly === "string") {
    phones.push(...identityOnly.split("|").map((phone) => phone.trim()).filter(Boolean));
  }
  return Array.from(new Set(phones));
}

export function buildLocalPreflight(
  rows: readonly RowData[],
  mapping: Mapping,
): { preflight: ImportPreflight; probes: PreflightProbe[] } {
  const groups = emptyGroups();
  const dncReasons: Record<number, string[]> = {};
  const probes: PreflightProbe[] = [];
  const seenAddresses = new Set<string>();

  rows.forEach((row, rowIndex) => {
    const validated = validateRow(row, mapping, rowIndex);
    const normalized = validated.normalized;
    const hasAnyValue = Object.values(row).some(
      (value) => value != null && String(value).trim().length > 0,
    );
    if (!hasAnyValue || Object.keys(normalized).length === 0) {
      groups.empty.push(rowIndex);
      groups.blocked.push(rowIndex);
      return;
    }
    if (!validated.ok) {
      groups.malformed.push(rowIndex);
      groups.blocked.push(rowIndex);
    }

    const address =
      typeof normalized.address === "string"
        ? normalizeAddress(normalized.address)
        : null;
    if (address) {
      if (seenAddresses.has(address)) groups.duplicates.push(rowIndex);
      else seenAddresses.add(address);
    }

    const phones = normalizedPhones(normalized);
    const email = normalized.homeowner_email;
    if (phones.length === 0 && !(typeof email === "string" && email.length > 0)) {
      groups.noUsableContact.push(rowIndex);
      groups.warnings.push(rowIndex);
    }

    if (normalized.homeowner_do_not_contact === true) {
      groups.dnc.push(rowIndex);
      dncReasons[rowIndex] = ["File marks this contact Do Not Contact"];
    }

    probes.push({ rowIndex, addressNormalized: address, phones });
  });

  const blocked = new Set(groups.blocked);
  const dnc = new Set(groups.dnc);
  for (let index = 0; index < rows.length; index++) {
    if (!blocked.has(index) && !dnc.has(index)) groups.new.push(index);
  }

  return {
    preflight: summarizePreflight(rows.length, groups, dncReasons),
    probes,
  };
}

export function mergeServerPreflight(
  local: ImportPreflight,
  server: {
    existingRowIndexes: readonly number[];
    dncRows: ReadonlyArray<{ rowIndex: number; reasons: string[] }>;
  },
): ImportPreflight {
  const groups = Object.fromEntries(
    Object.entries(local.groups).map(([key, values]) => [key, [...values]]),
  ) as Record<PreflightGroup, number[]>;
  const existing = new Set([...groups.existing, ...server.existingRowIndexes]);
  const dnc = new Set(groups.dnc);
  const dncReasons = { ...local.dncReasons };

  for (const row of server.dncRows) {
    dnc.add(row.rowIndex);
    dncReasons[row.rowIndex] = Array.from(
      new Set([...(dncReasons[row.rowIndex] ?? []), ...row.reasons]),
    );
  }
  groups.existing = [...existing].sort((a, b) => a - b);
  groups.dnc = [...dnc].sort((a, b) => a - b);

  const blocked = new Set(groups.blocked);
  groups.new = Array.from({ length: local.total }, (_, index) => index).filter(
    (index) => !blocked.has(index) && !existing.has(index) && !dnc.has(index),
  );
  return summarizePreflight(local.total, groups, dncReasons);
}

function summarizePreflight(
  total: number,
  groups: Record<PreflightGroup, number[]>,
  dncReasons: Record<number, string[]>,
): ImportPreflight {
  const blocked = new Set(groups.blocked);
  return {
    total,
    ready: total - blocked.size,
    existingMatches: groups.existing.length,
    inFileDuplicates: groups.duplicates.length,
    empty: groups.empty.length,
    malformed: groups.malformed.length,
    noUsableContact: groups.noUsableContact.length,
    dnc: groups.dnc.length,
    groups,
    dncReasons,
  };
}

export function rowsForGroup(
  rows: readonly Record<string, string>[],
  indexes: readonly number[],
): Record<string, string>[] {
  return indexes.map((index) => rows[index]).filter(Boolean);
}
