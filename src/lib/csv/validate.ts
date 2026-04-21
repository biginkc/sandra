import { ALL_FIELDS, PROPERTY_FIELDS, type TargetField } from "./schema";
import {
  normalizeAddress,
  normalizeApn,
  normalizeCountyName,
  normalizePhone,
  normalizeStateCode,
  normalizeZip,
  toBoolOrNull,
  toIntOrNull,
  toNumberOrNull,
  toStringOrNull,
} from "./normalize";

export type RowData = Readonly<Record<string, string | null | undefined>>;
export type Mapping = Readonly<Record<string, string | null>>;

export type FieldError = {
  fieldId: string;
  label: string;
  value: string | null;
  rule: string;
  message: string;
};

export type ValidatedRow = {
  rowIndex: number;
  ok: boolean;
  errors: FieldError[];
  warnings: FieldError[];
  /** Normalized value per target field id (null when unmapped / invalid). */
  normalized: Readonly<Record<string, unknown>>;
};

/**
 * Pull the raw value for a target field from a CSV row, using the wizard mapping.
 * Returns null when the field is unmapped or the raw cell is empty.
 */
function rawFor(
  row: RowData,
  mapping: Mapping,
  fieldId: string,
): string | null {
  const header = mapping[fieldId];
  if (!header) return null;
  const v = row[header];
  if (v == null) return null;
  const s = String(v).trim();
  return s.length > 0 ? s : null;
}

function normalizeByType(
  field: TargetField,
  raw: string | null,
): unknown {
  if (raw == null) return null;

  switch (field.type) {
    case "text":
    case "apn":
      return field.type === "apn" ? normalizeApn(raw) : toStringOrNull(raw);
    case "phone":
      return normalizePhone(raw);
    case "email": {
      const s = raw.trim().toLowerCase();
      return s.length > 0 ? s : null;
    }
    case "zip":
      return normalizeZip(raw);
    case "number":
      return toNumberOrNull(raw);
    case "int":
      return toIntOrNull(raw);
    case "boolean":
      return toBoolOrNull(raw);
    case "state":
      return normalizeStateCode(raw);
    case "address":
      return toStringOrNull(raw); // raw address kept; normalization happens into address_normalized
    case "county":
      return normalizeCountyName(raw);
    case "enum":
      if (!field.enumValues) return toStringOrNull(raw);
      const s = raw.trim().toLowerCase().replace(/\s+/g, "_");
      return field.enumValues.includes(s) ? s : null;
    default:
      return toStringOrNull(raw);
  }
}

/**
 * Validate a mapped row. Returns normalized values + any errors/warnings.
 */
export function validateRow(
  row: RowData,
  mapping: Mapping,
  rowIndex: number,
): ValidatedRow {
  const errors: FieldError[] = [];
  const warnings: FieldError[] = [];
  const normalized: Record<string, unknown> = {};

  // Skip blank rows entirely
  const hasAnyValue = Object.values(row).some(
    (v) => v != null && String(v).trim().length > 0,
  );
  if (!hasAnyValue) {
    return { rowIndex, ok: false, errors: [], warnings: [], normalized: {} };
  }

  for (const field of ALL_FIELDS) {
    const raw = rawFor(row, mapping, field.id);
    const value = normalizeByType(field, raw);
    normalized[field.id] = value;

    if (field.required && raw == null) {
      errors.push({
        fieldId: field.id,
        label: field.label,
        value: null,
        rule: "required",
        message: `${field.label} is required but the mapped column is empty`,
      });
      continue;
    }

    // Raw present but normalized to null → invalid
    if (raw != null && value == null && field.type !== "text") {
      errors.push({
        fieldId: field.id,
        label: field.label,
        value: raw,
        rule: `invalid_${field.type}`,
        message: `${field.label} value "${raw}" is not a valid ${field.type}`,
      });
    }
  }

  // Property-level required check (at least address + state)
  const addressMapped = !!mapping.address;
  const stateMapped = !!mapping.state;
  if (!addressMapped) {
    errors.push({
      fieldId: "address",
      label: "Address",
      value: null,
      rule: "section_required",
      message: "Address column must be mapped for every import",
    });
  }
  if (!stateMapped) {
    errors.push({
      fieldId: "state",
      label: "State",
      value: null,
      rule: "section_required",
      message: "State column must be mapped for every import",
    });
  }

  // Entity contacts need entity_name; warn if missing
  const contactType = normalized.homeowner_contact_type as string | null;
  const entityName = normalized.homeowner_entity_name as string | null;
  if (contactType === "entity" && !entityName) {
    errors.push({
      fieldId: "homeowner_entity_name",
      label: "Entity Name",
      value: null,
      rule: "entity_requires_name",
      message:
        "Homeowner marked as entity but entity name is empty. Map the LLC/trust name column.",
    });
  }

  return {
    rowIndex,
    ok: errors.length === 0,
    errors,
    warnings,
    normalized,
  };
}

/**
 * Aggregate counts for the Review step's badge.
 */
export type ValidationSummary = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  emptyRows: number;
  errorsByRule: Record<string, number>;
};

export function summarize(rows: ValidatedRow[]): ValidationSummary {
  const summary: ValidationSummary = {
    totalRows: rows.length,
    validRows: 0,
    invalidRows: 0,
    emptyRows: 0,
    errorsByRule: {},
  };
  for (const r of rows) {
    const hasContent = Object.keys(r.normalized).length > 0;
    if (!hasContent) {
      summary.emptyRows++;
      continue;
    }
    if (r.ok) summary.validRows++;
    else summary.invalidRows++;
    for (const e of r.errors) {
      summary.errorsByRule[e.rule] = (summary.errorsByRule[e.rule] ?? 0) + 1;
    }
  }
  return summary;
}

/**
 * Detect which sections of a mapping have at least one column mapped.
 * Used by the ingest code to decide whether to upsert a contact + sidecar
 * for each group.
 */
export function mappedSections(mapping: Mapping): {
  property: boolean;
  homeowner: boolean;
  agent: boolean;
} {
  const hasAny = (ids: readonly TargetField[]) =>
    ids.some((f) => !!mapping[f.id]);
  return {
    property: hasAny(PROPERTY_FIELDS),
    homeowner: Object.keys(mapping).some(
      (id) => id.startsWith("homeowner_") && !!mapping[id],
    ),
    agent: Object.keys(mapping).some(
      (id) => id.startsWith("agent_") && !!mapping[id],
    ),
  };
}
