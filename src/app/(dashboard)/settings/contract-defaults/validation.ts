import {
  ESIGN_NOVATION_FIELD_NAMES,
  ESIGN_RESIDENTIAL_FIELD_NAMES,
} from "@/lib/esign/contracts";

/** Economic terms are decided per deal, never defaulted at the template level. */
export const ECONOMIC_FIELD_KEYS: readonly string[] = [
  "offer_price",
  "cash_balance",
  "closing_date",
  "earnest_money",
];

export const MARKETS = ["Kansas City", "St. Louis", "Dayton", "Lake of the Ozarks"] as const;

export const ALLOWED_TEMPLATE_DEFAULT_KEYS: readonly string[] = [
  ...new Set<string>([...ESIGN_NOVATION_FIELD_NAMES, ...ESIGN_RESIDENTIAL_FIELD_NAMES]),
].filter((key) => !ECONOMIC_FIELD_KEYS.includes(key));

export type FieldDefaultsParse =
  | { ok: true; value: Record<string, string> }
  | { ok: false; errors: string[] };

/** Parses `key=value` lines. Blank lines are ignored; everything else must validate. */
export function parseTemplateFieldDefaults(text: string): FieldDefaultsParse {
  const value: Record<string, string> = {};
  const errors: string[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") return;
    const n = index + 1;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      errors.push(`Line ${n}: expected key=value.`);
      return;
    }
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (ECONOMIC_FIELD_KEYS.includes(key)) {
      errors.push(`Line ${n}: ${key} is set per deal and cannot be a template default.`);
    } else if (!ALLOWED_TEMPLATE_DEFAULT_KEYS.includes(key)) {
      errors.push(`Line ${n}: ${key} is not a known contract field.`);
    } else if (val === "") {
      errors.push(`Line ${n}: ${key} needs a value.`);
    } else if (Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push(`Line ${n}: ${key} is listed twice.`);
    } else {
      value[key] = val;
    }
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

export function formatTemplateFieldDefaults(defaults: Record<string, unknown> | null | undefined): string {
  return Object.entries(defaults ?? {})
    .filter(([, v]) => typeof v === "string")
    .map(([k, v]) => `${k}=${v as string}`)
    .join("\n");
}

/** Dollars typed by the owner -> whole cents. Blank or invalid -> null (caller refuses to save). */
export function dollarsToCents(input: string): number | null {
  const t = input.trim().replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const [d, c = ""] = t.split(".");
  return Number(d) * 100 + Number(c.padEnd(2, "0"));
}

export function centsToDollars(cents: number | string | null | undefined): string {
  if (cents === null || cents === undefined || cents === "") return "";
  const n = Number(cents);
  if (!Number.isFinite(n)) return "";
  return (n / 100).toFixed(2);
}
