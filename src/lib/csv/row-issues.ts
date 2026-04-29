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

  for (const v of validated) {
    // Empty rows have no normalized fields and no errors — they're not
    // actionable in either bucket.
    if (Object.keys(v.normalized).length === 0) continue;

    const id = rowIdentifier(v.normalized) ?? rowFallback(v.rowIndex);
    const issue: RowIssue = { rowIndex: v.rowIndex, identifier: id };

    if (!v.ok) {
      // One row can have multiple errors. Each lands in its own group so
      // a single row may appear in (e.g.) both "Address missing" and
      // "State missing" — that's intentional, the user fixing one issue
      // shouldn't lose track of the other.
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
    } else {
      // Warnings are computed only for valid rows — they only matter for
      // rows that will actually land in the DB.
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
  }

  return {
    blockers: [...blockerMap.values()].sort(
      (a, b) => b.totalCount - a.totalCount,
    ),
    warnings: [...warningMap.values()].sort(
      (a, b) => b.totalCount - a.totalCount,
    ),
  };
}
