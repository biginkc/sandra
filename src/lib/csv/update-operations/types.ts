import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import type { PropertyForMatch } from "../match-by-address";

export type SubOperationId =
  | "update-property-status"
  | "tag-existing-properties"
  | "update-motivation-level"
  | "update-homeowner-phones"
  | "update-agent-phones"
  | "update-homeowner-emails"
  | "update-agent-emails";

export type ParsedRow = Record<string, string>;

export type RowResult =
  | {
      kind: "updated";
      rowIndex: number;
      address: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  | {
      kind: "unchanged";
      rowIndex: number;
      address: string;
      reason: "no-change" | "blank";
    }
  | {
      kind: "rejected";
      rowIndex: number;
      address: string;
      reason: string;
      detail?: string;
      unknownTags?: string[];
    };

export type SubOperationContext = {
  supabase: SupabaseClient<Database>;
  userId: string | null;
};

export type SubOperationApplyArgs = {
  rowIndex: number;
  parsedRow: ParsedRow;
  property: PropertyForMatch;
};

export type SubOperationApplyOptions = {
  /** When true, the module performs all lookups + validation but skips
   *  the final write. Used by the preview step. */
  dryRun: boolean;
};

export type SubOperationModule = {
  id: SubOperationId;
  label: string;
  description: string;
  /** Headers the CSV MUST contain. */
  requiredColumns: string[];
  /** Headers the CSV MAY contain (used as context, not required). */
  optionalColumns: string[];
  /** 2-3 demo rows used to render the "See example" dialog. */
  exampleRows: ParsedRow[];
  apply(
    ctx: SubOperationContext,
    args: SubOperationApplyArgs,
    options: SubOperationApplyOptions,
  ): Promise<RowResult>;
};
