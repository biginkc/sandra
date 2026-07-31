import { ALL_FIELDS, PROPERTY_FIELDS, type TargetField } from "./schema";
import { isDoNotCallLabel, lineTypeFromVendorLabel } from "@/lib/messaging/line-type";
import {
  classifyAddressFullFailure,
  normalizeApn,
  normalizeCountyName,
  normalizePhone,
  normalizeStateCode,
  normalizeZip,
  parseFullAddress,
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
      if (isPhoneLineTypeField(field)) {
        const lineType = lineTypeFromVendorLabel(raw);
        if (lineType !== "unknown") return lineType;
        // A do-not-call marker (DealMachine writes "DO NOT CALL" into the
        // line-type column) isn't a real line type. Normalize it to the
        // valid 'unknown' value so the number drops under the no-line-type
        // hard rule instead of failing the whole row on invalid_enum — the
        // protective signal is carried separately by validateRow Pass 1b.
        if (isDoNotCallLabel(raw)) return "unknown";
      }
      const s = raw.trim().toLowerCase().replace(/\s+/g, "_");
      return field.enumValues.includes(s) ? s : null;
    default:
      return toStringOrNull(raw);
  }
}

function isPhoneLineTypeField(field: TargetField): boolean {
  return (
    field.id === "homeowner_phone_1_type" ||
    field.id === "homeowner_phone_2_type" ||
    field.id === "homeowner_phone_3_type" ||
    field.id === "agent_phone_type"
  );
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

  // Pass 1: normalize every target field from its directly mapped column
  for (const field of ALL_FIELDS) {
    const raw = rawFor(row, mapping, field.id);
    normalized[field.id] = normalizeByType(field, raw);
  }

  // Pass 1b: decode per-phone do-not-call markers. DealMachine flags a
  // number "DO NOT CALL" inside its line-type column instead of a
  // separate DNC field; that label normalizes to 'unknown' so the number
  // itself drops at ingest (migration 080), but the protective signal
  // must survive as a contact-level Do Not Contact flag. Mirrors
  // PropStream's `Phone N DNC` fold and REISift's "DNC Excluded" sentinel.
  // One-way: only ever raises the flag, never clears an explicit `false`.
  for (const slot of [1, 2, 3] as const) {
    const phoneRaw = rawFor(row, mapping, `homeowner_phone_${slot}`);
    const typeRaw = rawFor(row, mapping, `homeowner_phone_${slot}_type`);
    if (phoneRaw != null && isDoNotCallLabel(typeRaw)) {
      normalized.homeowner_do_not_contact = true;
    }
  }

  // Pass 2: derive address/city/state/zip from a combined-address column
  // when it's mapped AND the individual fields aren't. Lets DealMachine
  // Skipped (single `associated_property_address_full` column) flow through.
  // Track the failure reason so Pass 3 can emit a specific error rule
  // (most common real-world case: DealMachine rows where the skip-trace
  // found a city but no street — "Weston, MO 64098").
  let addressFullFailure:
    | "empty"
    | "no_street"
    | "malformed"
    | null = null;
  if (mapping.address_full) {
    const addressFullRaw = normalized.address_full as string | null;
    const parsed = parseFullAddress(addressFullRaw);
    if (parsed) {
      if (!mapping.address) normalized.address = parsed.address;
      if (!mapping.city && parsed.city) normalized.city = parsed.city;
      if (!mapping.state) normalized.state = normalizeStateCode(parsed.state);
      if (!mapping.zip && parsed.zip) normalized.zip = normalizeZip(parsed.zip);
    } else {
      addressFullFailure = classifyAddressFullFailure(addressFullRaw);
    }
  }

  // Pass 3: report per-field errors against the resolved values. When the
  // root cause is an unparseable combined-address column, emit a single
  // specific error instead of duplicating required-errors on Address and
  // State (they're both downstream consequences of the same problem).
  const suppressRequiredRootCause =
    !!mapping.address_full &&
    !mapping.address &&
    !mapping.state &&
    addressFullFailure !== null;
  for (const field of ALL_FIELDS) {
    const raw = rawFor(row, mapping, field.id);
    const value = normalized[field.id];

    if (field.required && value == null) {
      if (
        suppressRequiredRootCause &&
        (field.id === "address" || field.id === "state")
      ) {
        // Emit only once, on the address field, with the specific reason.
        if (field.id === "address") {
          errors.push({
            fieldId: "address_full",
            label: "Full Address",
            value: null,
            rule: `address_full_${addressFullFailure}`,
            message:
              addressFullFailure === "empty"
                ? "Full Address column is empty — no street, city, or state to import."
                : addressFullFailure === "no_street"
                  ? "Full Address has only city/state (no street) — DealMachine skip-trace didn't locate the property."
                  : "Full Address value couldn't be parsed into address + city + state + ZIP.",
          });
        }
        continue;
      }

      const mappedDirectly = !!mapping[field.id];
      const derivable =
        (field.id === "address" || field.id === "state") &&
        !!mapping.address_full;
      if (!mappedDirectly && !derivable) {
        errors.push({
          fieldId: field.id,
          label: field.label,
          value: null,
          rule: "section_required",
          message: `${field.label} column must be mapped for every import`,
        });
      } else {
        errors.push({
          fieldId: field.id,
          label: field.label,
          value: null,
          rule: "required",
          message: mappedDirectly
            ? `${field.label} is required but the mapped column is empty`
            : `${field.label} is required but could not be derived from the combined-address column`,
        });
      }
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
 *
 * `errorsByRule` drives the blocking error chips. `warningsByRule` drives
 * non-blocking soft-warning chips — things like "50 rows have no phone"
 * that are worth surfacing before Confirm but don't disqualify the import.
 */
export type ValidationSummary = {
  totalRows: number;
  validRows: number;
  invalidRows: number;
  emptyRows: number;
  errorsByRule: Record<string, number>;
  warningsByRule: Record<string, number>;
};

export function summarize(rows: ValidatedRow[]): ValidationSummary {
  const summary: ValidationSummary = {
    totalRows: rows.length,
    validRows: 0,
    invalidRows: 0,
    emptyRows: 0,
    errorsByRule: {},
    warningsByRule: {},
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
    // Contact-coverage warnings — only meaningful for valid rows (invalid
    // rows don't land in the DB anyway, so contact gaps don't matter).
    if (r.ok) {
      for (const rule of computeContactWarningRules(r.normalized)) {
        summary.warningsByRule[rule] =
          (summary.warningsByRule[rule] ?? 0) + 1;
      }
    }
  }
  return summary;
}

/**
 * Produce the set of contact-coverage warning rules that apply to a single
 * validated row. Returns an empty array when the row has at least one
 * usable contact channel.
 *
 * Rules (mutually exclusive in practice — `no_contact` subsumes the more
 * specific ones):
 *  - `no_contact`        — nothing to call, text, email, or personalize
 *  - `no_phone`          — has a name or email but no phone slot filled
 *  - `no_mailing_address` — property address will double as mailing address
 */
export function computeContactWarningRules(
  normalized: Readonly<Record<string, unknown>>,
): string[] {
  const phone =
    !!normalized.homeowner_phone_1 ||
    !!normalized.homeowner_phone_2 ||
    !!normalized.homeowner_phone_3;
  const email = !!normalized.homeowner_email;
  const name =
    !!normalized.homeowner_first_name ||
    !!normalized.homeowner_last_name ||
    !!normalized.homeowner_entity_name;
  const mailing = !!normalized.homeowner_mailing_address;

  const rules: string[] = [];
  if (!phone && !email && !name) {
    // Nothing usable at all — this single rule covers the row.
    rules.push("no_contact");
  } else if (!phone) {
    rules.push("no_phone");
  }
  if (!mailing) rules.push("no_mailing_address");
  return rules;
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
