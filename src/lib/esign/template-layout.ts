import type {
  TemplateFieldLayout,
  TemplateFieldLayoutField,
  TemplateSignerRole,
} from "./contracts";

export type TemplateResponseish = Record<string, unknown>;

export type TemplateLayoutErrorCode =
  | "INVALID_TEMPLATE"
  | "INVALID_SIGNER_ROLES"
  | "INVALID_DOCUMENT"
  | "INVALID_FIELD"
  | "UNKNOWN_FIELD_TYPE"
  | "UNKNOWN_SIGNER_ROLE";

export class TemplateLayoutError extends Error {
  constructor(
    public readonly code: TemplateLayoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TemplateLayoutError";
  }
}

export class UnknownTemplateFieldTypeError extends TemplateLayoutError {
  constructor(
    public readonly fieldType: string,
    public readonly fieldKind: "form" | "custom",
  ) {
    super(
      "UNKNOWN_FIELD_TYPE",
      `Dropbox Sign returned an unsupported ${fieldKind} field type.`,
    );
    this.name = "UnknownTemplateFieldTypeError";
  }
}

const FORM_FIELD_TYPES = new Set([
  "checkbox",
  "date_signed",
  "dropdown",
  "hyperlink",
  "initials",
  "radio",
  "signature",
  "text",
]);

const CUSTOM_FIELD_TYPES = new Set(["checkbox", "text"]);

/**
 * Convert the provider's templateGet response into the stable layout contract
 * consumed by the file-based sender. This deliberately accepts both the
 * snake_case HTTP response and the camelCase SDK model representation.
 */
export function normalizeTemplateLayout(
  template: TemplateResponseish,
): TemplateFieldLayout {
  const source = requireRecord(template, "INVALID_TEMPLATE");
  const signerRoles = normalizeSignerRoles(
    readArray(source, "signer_roles", "signerRoles"),
  );
  const topLevelCustomFields = readArray(
    source,
    "custom_fields",
    "customFields",
  );
  const mergeFieldNames = uniqueStrings(
    topLevelCustomFields.map((field, index) =>
      normalizeMergeFieldName(field, `template.custom_fields[${index}]`),
    ),
  );
  const documents = readArray(source, "documents").map((value, index) =>
    normalizeDocument(value, index, signerRoles, mergeFieldNames),
  );

  return {
    version: 1,
    signerRoles,
    mergeFieldNames,
    documents,
  };
}

function normalizeSignerRoles(values: unknown[]): TemplateSignerRole[] {
  if (values.length === 0) {
    throw new TemplateLayoutError(
      "INVALID_SIGNER_ROLES",
      "Dropbox Sign returned no signer roles.",
    );
  }
  const roles = values.map((value, index) => {
    const role = requireRecord(value, "INVALID_SIGNER_ROLES");
    const name = requireString(
      readValue(role, "name"),
      "INVALID_SIGNER_ROLES",
      "Dropbox Sign returned a signer role without a name.",
    );
    const order = readInteger(readValue(role, "order"), index);
    if (!Number.isSafeInteger(order) || order < 0) {
      throw new TemplateLayoutError(
        "INVALID_SIGNER_ROLES",
        "Dropbox Sign returned a signer role with an invalid order.",
      );
    }
    return { name, order };
  });
  const names = new Set<string>();
  const orders = new Set<number>();
  for (const role of roles) {
    if (names.has(role.name) || orders.has(role.order)) {
      throw new TemplateLayoutError(
        "INVALID_SIGNER_ROLES",
        "Dropbox Sign returned duplicate signer role identities.",
      );
    }
    names.add(role.name);
    orders.add(role.order);
  }
  return roles.sort((left, right) => left.order - right.order);
}

function normalizeDocument(
  value: unknown,
  fallbackIndex: number,
  signerRoles: readonly TemplateSignerRole[],
  mergeFieldNames: string[],
): TemplateFieldLayout["documents"][number] {
  const document = requireRecord(value, "INVALID_DOCUMENT");
  const index = readInteger(readValue(document, "index"), fallbackIndex);
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new TemplateLayoutError(
      "INVALID_DOCUMENT",
      "Dropbox Sign returned a document with an invalid index.",
    );
  }
  const name = requireString(
    readValue(document, "name"),
    "INVALID_DOCUMENT",
    "Dropbox Sign returned a document without a name.",
  );
  const formFields = readArray(document, "form_fields", "formFields");
  const customFields = readArray(document, "custom_fields", "customFields");
  const fields = [
    ...formFields.map((field, fieldIndex) =>
      normalizeField(
        field,
        "form",
        `documents[${fallbackIndex}].form_fields[${fieldIndex}]`,
        signerRoles,
      ),
    ),
    ...customFields.map((field, fieldIndex) =>
      normalizeField(
        field,
        "custom",
        `documents[${fallbackIndex}].custom_fields[${fieldIndex}]`,
        signerRoles,
      ),
    ),
  ];
  for (const field of fields) {
    if (field.signer === "sender") {
      uniquePush(mergeFieldNames, field.name);
    }
  }
  return { index, name, fields };
}

function normalizeField(
  value: unknown,
  kind: "form" | "custom",
  location: string,
  signerRoles: readonly TemplateSignerRole[],
): TemplateFieldLayoutField {
  const field = requireRecord(value, "INVALID_FIELD");
  const type = requireString(
    readValue(field, "type"),
    "INVALID_FIELD",
    `Dropbox Sign returned a field without a type at ${location}.`,
  ).toLowerCase();
  const allowedTypes = kind === "form" ? FORM_FIELD_TYPES : CUSTOM_FIELD_TYPES;
  if (!allowedTypes.has(type)) {
    throw new UnknownTemplateFieldTypeError(type, kind);
  }
  const apiId = requireString(
    readValue(field, "api_id", "apiId"),
    "INVALID_FIELD",
    `Dropbox Sign returned a field without an API id at ${location}.`,
  );
  const name = requireString(
    readValue(field, "name"),
    "INVALID_FIELD",
    `Dropbox Sign returned a field without a name at ${location}.`,
  );
  const coordinates = {
    x: readCoordinate(field, "x", location),
    y: readCoordinate(field, "y", location),
    width: readCoordinate(field, "width", location),
    height: readCoordinate(field, "height", location),
  };
  const rawSigner = readValue(field, "signer");
  const signer = normalizeSigner(rawSigner, kind, signerRoles, location);
  const page = readPage(field, location);
  const group = readOptionalString(readValue(field, "group"));

  return {
    apiId,
    name,
    type,
    signer,
    page,
    ...coordinates,
    required: readValue(field, "required") === true,
    ...(group ? { group } : {}),
  };
}

function normalizeSigner(
  value: unknown,
  kind: "form" | "custom",
  signerRoles: readonly TemplateSignerRole[],
  location: string,
): number | "sender" {
  if (kind === "custom" && (value == null || isSender(value))) {
    return "sender";
  }
  const roleIndex = resolveSignerRole(value, signerRoles);
  if (roleIndex !== null) return roleIndex;
  if (kind === "custom") {
    throw new TemplateLayoutError(
      "INVALID_FIELD",
      `Dropbox Sign custom field is not assigned to the sender at ${location}.`,
    );
  }
  throw new TemplateLayoutError(
    "UNKNOWN_SIGNER_ROLE",
    `Dropbox Sign returned an unknown signer role at ${location}.`,
  );
}

function resolveSignerRole(
  value: unknown,
  signerRoles: readonly TemplateSignerRole[],
): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const byName = signerRoles.find((role) => role.name === trimmed);
    if (byName) return byName.order;
    if (!/^\d+$/.test(trimmed)) return null;
    const oneBasedIndex = Number(trimmed) - 1;
    return signerRoles[oneBasedIndex]?.order ?? null;
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return signerRoles[value - 1]?.order ?? null;
  }
  return null;
}

function normalizeMergeFieldName(value: unknown, location: string): string {
  const field = requireRecord(value, "INVALID_FIELD");
  const type = requireString(
    readValue(field, "type"),
    "INVALID_FIELD",
    `Dropbox Sign returned a merge field without a type at ${location}.`,
  ).toLowerCase();
  if (!CUSTOM_FIELD_TYPES.has(type)) {
    throw new UnknownTemplateFieldTypeError(type, "custom");
  }
  if (!(
    readValue(field, "signer") == null ||
    isSender(readValue(field, "signer"))
  )) {
    throw new TemplateLayoutError(
      "INVALID_FIELD",
      `Dropbox Sign merge field is not assigned to the sender at ${location}.`,
    );
  }
  return requireString(
    readValue(field, "name"),
    "INVALID_FIELD",
    `Dropbox Sign returned a merge field without a name at ${location}.`,
  );
}

function readCoordinate(
  record: Record<string, unknown>,
  key: string,
  location: string,
): number {
  const value = readValue(record, key);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TemplateLayoutError(
      "INVALID_FIELD",
      `Dropbox Sign returned an invalid ${key} coordinate at ${location}.`,
    );
  }
  return value;
}

function readPage(record: Record<string, unknown>, location: string): number {
  const raw = readValue(record, "page", "page_number", "pageNumber");
  if (raw == null) return 0;
  const page = readInteger(raw, Number.NaN);
  if (page < 0 || !Number.isFinite(page)) {
    throw new TemplateLayoutError(
      "INVALID_FIELD",
      `Dropbox Sign returned an invalid page at ${location}.`,
    );
  }
  return page;
}

function readInteger(value: unknown, fallback: number): number {
  if (value == null) return fallback;
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
  }
  return Number.NaN;
}

function readArray(record: Record<string, unknown>, ...keys: string[]): unknown[] {
  const value = readValue(record, ...keys);
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new TemplateLayoutError(
      "INVALID_TEMPLATE",
      "Dropbox Sign returned a template collection with an invalid shape.",
    );
  }
  return value;
}

function readValue(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (Object.hasOwn(record, key)) return record[key];
  }
  return undefined;
}

function requireRecord(value: unknown, code: TemplateLayoutErrorCode): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new TemplateLayoutError(code, "Dropbox Sign returned an invalid template shape.");
}

function requireString(
  value: unknown,
  code: TemplateLayoutErrorCode,
  message: string,
): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new TemplateLayoutError(code, message);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSender(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "sender";
}

function uniqueStrings(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) === index);
}

function uniquePush(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

export type { TemplateFieldLayout, TemplateFieldLayoutField, TemplateSignerRole };
