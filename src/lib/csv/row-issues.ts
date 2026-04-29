/**
 * Row-level breakdown of validation outcomes for the wizard's Review step.
 *
 * `summarize()` (validate.ts) gives the wizard the headline counts. This
 * module gives it the per-issue, per-row detail needed to render the
 * expandable tile/label design: which rule type affected which rows, with
 * an identifier per row so the user can find that row in their CSV.
 *
 * Two buckets:
 *   - blockers: validation errors that prevent the row from importing
 *   - warnings: contact-coverage warnings that don't block (e.g. no phone)
 *
 * Both are sorted by row count descending, so the most common issue is
 * always at the top.
 */

import { ruleLabel } from "./error-labels";
import { normalizeAddress } from "./normalize";
import {
  computeContactWarningRules,
  type ValidatedRow,
} from "./validate";

export type RowIssue = {
  /** 0-indexed position of the row in the source CSV (header excluded). */
  rowIndex: number;
  /** A human-readable identifier — typically the address, falling back to
   *  homeowner name, then "Row N" when nothing identifies the row. */
  identifier: string;
};

export type RowIssueGroup = {
  /** Stable key for React iteration / persistence across renders. */
  ruleKey: string;
  /** User-facing label, e.g. "Address missing" / "Invalid phone number". */
  ruleLabel: string;
  rows: RowIssue[];
  totalCount: number;
};

export type RowIssueBreakdown = {
  blockers: RowIssueGroup[];
  warnings: RowIssueGroup[];
  /**
   * Rows that won't add a NEW property — but for non-error reasons. Two
   * sub-types today:
   *   - intra_file_duplicate: row N has the same normalized address as
   *     an earlier row in the same file. Importer dedups → row N still
   *     gets list-stacked but doesn't create a fresh record.
   *   - empty_row: row had no usable mapped values. Skipped silently.
   *
   * Surfaced separately from warnings (which apply to rows that WILL
   * insert) and blockers (rows that fail validation entirely).
   */
  infoSkips: RowIssueGroup[];
};

/**
 * Pick a meaningful identifier for a row from its already-validated
 * normalized values. Priority: address > homeowner first/last > entity
 * name > null. Caller is expected to fall back to "Row N" when null is
 * returned.
 */
export function rowIdentifier(
  normalized: Readonly<Record<string, unknown>>,
): string | null {
  const address = (normalized.address as string | null) ?? null;
  if (address) return address;

  const first = (normalized.homeowner_first_name as string | null) ?? null;
  const last = (normalized.homeowner_last_name as string | null) ?? null;
  if (first || last) {
    return [first, last].filter(Boolean).join(" ");
  }

  const entity = (normalized.homeowner_entity_name as string | null) ?? null;
  if (entity) return entity;

  return null;
}

/**
 * Build the user-facing label for a single error or warning group.
 *
 * `required` errors get the field name baked in ("Address missing"),
 * because the rule alone ("Missing required field") doesn't tell the user
 * what to fix. Other rules already imply their field (`invalid_phone` →
 * always Phone) so we use the rule's own label.
 */
function groupLabel(rule: string, fieldLabel: string): string {
  if (rule === "required") return `${fieldLabel} missing`;
  if (rule === "section_required") return `${fieldLabel} column not mapped`;
  return ruleLabel(rule);
}

/**
 * Warning rules are global (no fieldId) so we map them directly to a
 * compact, user-facing label.
 */
const WARNING_LABELS: Record<string, string> = {
  no_contact: "No contact info",
  no_phone: "No phone",
  no_mailing_address: "No separate mailing address",
};

function warningLabel(rule: string): string {
  return WARNING_LABELS[rule] ?? rule;
}

/**
 * One-indexed CSV row number including the header line. rowIndex 0
 * (the first data row) renders as "Row 2", matching what the user sees
 * when they open the file in a spreadsheet app.
 */
function rowFallback(rowIndex: number): string {
  return `Row ${rowIndex + 2}`;
}

export function groupRowIssues(
  validated: readonly ValidatedRow[],
): RowIssueBreakdown {
  const blockerMap = new Map<string, RowIssueGroup>();
  const warningMap = new Map<string, RowIssueGroup>();
  const infoSkipMap = new Map<string, RowIssueGroup>();

  // First pass — find intra-file duplicate addresses so we can mark the
  // 2nd-and-later occurrences as info-skips. Only valid (passes-validation)
  // rows compete for "winner" status; blocked rows are categorized as
  // blockers and don't enter dedup.
  const addressFirstSeen = new Map<string, number>();
  const duplicateRowIndices = new Set<number>();
  for (const v of validated) {
    if (!v.ok) continue;
    const addr = (v.normalized.address as string | null) ?? null;
    if (!addr) continue;
    const key = normalizeAddress(addr);
    if (!key) continue;
    if (addressFirstSeen.has(key)) {
      duplicateRowIndices.add(v.rowIndex);
    } else {
      addressFirstSeen.set(key, v.rowIndex);
    }
  }

  for (const v of validated) {
    const isEmpty = Object.keys(v.normalized).length === 0;
    const id = rowIdentifier(v.normalized) ?? rowFallback(v.rowIndex);
    const issue: RowIssue = { rowIndex: v.rowIndex, identifier: id };

    if (isEmpty) {
      // Surface empty rows as their own info-skip type so the user can see
      // why the row count math doesn't add up at Progress time.
      const key = "empty_row";
      const existing = infoSkipMap.get(key);
      if (existing) {
        existing.rows.push(issue);
        existing.totalCount++;
      } else {
        infoSkipMap.set(key, {
          ruleKey: key,
          ruleLabel: "Empty row (no property data)",
          rows: [issue],
          totalCount: 1,
        });
      }
      continue;
    }

    if (!v.ok) {
      // One row can have multiple errors. Each lands in its own group so
      // a single row may appear in (e.g.) both "Address missing" and
      // "State missing" — that's intentional, the user fixing one issue
      // shouldn't lose track of the other. Blockers take priority over
      // duplicate / warning categorization.
      for (const e of v.errors) {
        const key = `${e.rule}:${e.fieldId}`;
        const existing = blockerMap.get(key);
        if (existing) {
          existing.rows.push(issue);
          existing.totalCount++;
        } else {
          blockerMap.set(key, {
            ruleKey: key,
            ruleLabel: groupLabel(e.rule, e.label),
            rows: [issue],
            totalCount: 1,
          });
        }
      }
      continue;
    }

    // Valid row. Could be a duplicate (info-skip) OR a winner with warnings.
    if (duplicateRowIndices.has(v.rowIndex)) {
      const key = "intra_file_duplicate";
      const existing = infoSkipMap.get(key);
      if (existing) {
        existing.rows.push(issue);
        existing.totalCount++;
      } else {
        infoSkipMap.set(key, {
          ruleKey: key,
          ruleLabel: "Duplicate of an earlier row in this file",
          rows: [issue],
          totalCount: 1,
        });
      }
      continue;
    }

    // Winner — this row will actually create a property. Compute warnings.
    for (const rule of computeContactWarningRules(v.normalized)) {
      const existing = warningMap.get(rule);
      if (existing) {
        existing.rows.push(issue);
        existing.totalCount++;
      } else {
        warningMap.set(rule, {
          ruleKey: rule,
          ruleLabel: warningLabel(rule),
          rows: [issue],
          totalCount: 1,
        });
      }
    }
  }

  return {
    blockers: [...blockerMap.values()].sort(
      (a, b) => b.totalCount - a.totalCount,
    ),
    warnings: [...warningMap.values()].sort(
      (a, b) => b.totalCount - a.totalCount,
    ),
    infoSkips: [...infoSkipMap.values()].sort(
      (a, b) => b.totalCount - a.totalCount,
    ),
  };
}
