import Papa from "papaparse";

import type { Mapping, RowData } from "./validate";
import {
  GENERATED_DNC_HEADER,
  REVIEWED_DATASET_VERSION,
  reviewContractJson,
  type ReviewContractInput,
} from "./dataset-contract";
export {
  GENERATED_DNC_HEADER,
  REVIEWED_DATASET_VERSION,
} from "./dataset-contract";

/**
 * Serialize the exact in-memory rows the operator reviewed. Header order is
 * explicit so preset-generated fields and the generated DNC lock column are
 * stable across browsers and retries.
 */
export function serializeReviewedDataset(
  rows: readonly RowData[],
  headers: readonly string[],
): string {
  return Papa.unparse(
    {
      fields: [...headers],
      data: rows.map((row) =>
        headers.map((header) => {
          const value = row[header];
          return value == null ? "" : String(value);
        }),
      ),
    },
    { newline: "\n" },
  );
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function buildReviewContractSha256(
  input: ReviewContractInput,
): Promise<string> {
  return sha256Hex(reviewContractJson(input));
}

export async function buildReviewedDatasetFile(args: {
  rows: readonly RowData[];
  headers: readonly string[];
  filename: string;
}): Promise<{ file: File; csv: string; sha256: string; version: number }> {
  const csv = serializeReviewedDataset(args.rows, args.headers);
  return {
    file: new File([csv], args.filename.replace(/\.xlsx$/i, ".csv"), {
      type: "text/csv",
    }),
    csv,
    sha256: await sha256Hex(csv),
    version: REVIEWED_DATASET_VERSION,
  };
}

export function withGeneratedDncLocks(args: {
  rows: readonly Record<string, string>[];
  headers: readonly string[];
  mapping: Mapping;
  dncRowIndexes: readonly number[];
}): {
  rows: Record<string, string>[];
  headers: string[];
  mapping: Record<string, string | null>;
} {
  const dncIndexes = new Set(args.dncRowIndexes);
  return {
    rows: args.rows.map((row, index) => ({
      ...row,
      [GENERATED_DNC_HEADER]: dncIndexes.has(index) ? "true" : "",
    })),
    headers: args.headers.includes(GENERATED_DNC_HEADER)
      ? [...args.headers]
      : [...args.headers, GENERATED_DNC_HEADER],
    mapping: {
      ...args.mapping,
      homeowner_do_not_contact: GENERATED_DNC_HEADER,
    },
  };
}
