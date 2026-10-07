import { createHmac } from "node:crypto";

/**
 * Deterministic seller-phone masking for replay exports.
 *
 * Masked numbers are `+1 <real area code> 555 <4-digit line>`:
 *   - the area code is kept so quiet-hours / state logic still works;
 *   - the 555 exchange is not assigned to subscribers, so the number is not a
 *     real person's line. Only 555-0100..0199 is formally reserved for fiction
 *     (NANP); a 100-number block per area code cannot hold thousands of sellers
 *     without collisions, and a collision would merge two contacts and corrupt
 *     the replay. We therefore use the whole 555 exchange (10,000 lines per area
 *     code) and guarantee injectivity by probing. The masked numbers are never
 *     dialled: sends are impossible by construction (see safety.ts).
 *   - the line is HMAC-SHA256(salt, real10) so it cannot be brute-forced back.
 */

const SAFE_TOKENS =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/gi;

// 10 digits (optionally +1 / 1 prefix), separated by space, dot, dash or parens.
const PHONE_IN_TEXT =
  /(?<![\d$,.])(\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?![\d]|,\d{3})/g;

const SAFE_OR_PHONE = new RegExp(`(${SAFE_TOKENS.source})|${PHONE_IN_TEXT.source}`, "gi");

// 7-digit local numbers need a separator ("555-1234") so plain 7-digit amounts are not hit.
const LOCAL7_IN_TEXT = /(?<![\d$,.+-])(\d{3})[\s.-](\d{4})(?![\d]|,\d{3})/g;
// International (non +1) numbers: "+44 20 7946 0958", "+63 917 123 4567". Needs 9+ digits.
const INTL_IN_TEXT = /(?<![\w+])\+(?!1)\d[\d\s().-]{6,18}\d/g;
const EMAIL_IN_TEXT = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
export const MASKED_EMAIL_DOMAIN = "example.invalid";
const MASKED_EMAIL_TOKEN = /user-[0-9a-f]{10}@example\.invalid/g;

const SAFE_OR_LOCAL7 = new RegExp(`(${SAFE_TOKENS.source})|${LOCAL7_IN_TEXT.source}`, "gi");
const SAFE_OR_INTL = new RegExp(`(${SAFE_TOKENS.source})|${INTL_IN_TEXT.source}`, "gi");

const digitCount = (t: string) => t.replace(/\D/g, "").length;

export function last10(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

export class PhoneMasker {
  private readonly map = new Map<string, string>(); // real10 -> masked10
  private readonly used = new Set<string>(); // masked10
  private readonly keep: Set<string>;

  constructor(
    private readonly salt: string,
    keep: Iterable<string> = [],
    private readonly maskPii: boolean = false,
  ) {
    if (!salt || salt.length < 4) throw new Error("PhoneMasker requires a non-trivial salt");
    this.keep = new Set(
      [...keep].map((p) => last10(p)).filter((p): p is string => p !== null),
    );
  }

  isKept(raw: string | null | undefined): boolean {
    const d = last10(raw);
    return d !== null && this.keep.has(d);
  }

  /** E.164 masked number, or null when `raw` is not a parseable NANP number. */
  mask(raw: string | null | undefined): string | null {
    const real = last10(raw);
    if (!real) return null;
    const existing = this.map.get(real);
    if (existing) return `+1${existing}`;
    const area = real.slice(0, 3);
    const digest = createHmac("sha256", this.salt).update(real).digest();
    let line = digest.readUInt32BE(0) % 10_000;
    for (let i = 0; i < 10_000; i++) {
      const candidate = `${area}555${String(line).padStart(4, "0")}`;
      if (candidate !== real && !this.used.has(candidate) && !this.keep.has(candidate)) {
        this.used.add(candidate);
        this.map.set(real, candidate);
        return `+1${candidate}`;
      }
      line = (line + 1) % 10_000;
    }
    throw new Error(`PhoneMasker: area code ${area} exhausted (10,000 lines)`);
  }

  /** Mask a seller phone; business numbers pass through unchanged. */
  maskOrKeep(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    if (this.isKept(raw)) return raw;
    return this.mask(raw) ?? raw;
  }

  private hmacDigits(kind: string, input: string, n: number): string {
    const d = createHmac("sha256", this.salt).update(`${kind}:${input}`).digest();
    return String(d.readUInt32BE(0) % 10 ** n).padStart(n, "0");
  }

  private hmacHex(kind: string, input: string, n: number): string {
    return createHmac("sha256", this.salt).update(`${kind}:${input.trim().toLowerCase()}`).digest("hex").slice(0, n);
  }

  /** Deterministic pseudonym for a name column (only when PII masking is on). */
  maskName(kind: "first" | "last" | "entity", value: string | null | undefined): string | null | undefined {
    if (!this.maskPii || value == null || value === "") return value;
    const label = { first: "First", last: "Last", entity: "Entity" }[kind];
    return `${label}-${this.hmacHex(kind, value, 6)}`;
  }

  /** Numeric phones inside JSON (10 digits, or 11 starting with 1) become masked numbers. */
  maskNumber(n: number): number {
    if (!Number.isSafeInteger(n) || n < 0) return n;
    const digits = String(n);
    if (digits.length !== 10 && !(digits.length === 11 && digits.startsWith("1"))) return n;
    const real = last10(digits);
    if (!real || !/^[2-9]/.test(real) || this.keep.has(real)) return n;
    const masked = this.mask(real);
    if (!masked) return n;
    return Number(digits.length === 11 ? masked.slice(1) : masked.slice(2));
  }

  /** Replace every phone number (and, with PII masking, email) inside free text; everything else is verbatim. */
  maskText(text: string): string {
    // One pass over "safe token | phone" so uuids / ISO timestamps are never rewritten.
    let out = text.replace(SAFE_OR_PHONE, (match, safe?: string, prefix?: string, a?: string, b?: string, c?: string) => {
      if (safe !== undefined) return match;
      const real = `${a}${b}${c}`;
      if (this.keep.has(real)) return match;
      const masked = this.mask(real);
      if (!masked) return match;
      const m10 = masked.slice(2);
      return `${prefix ?? ""}${m10.slice(0, 3)}-${m10.slice(3, 6)}-${m10.slice(6)}`;
    });
    // 7-digit local numbers (no area code): 555 exchange, deterministic line.
    out = out.replace(SAFE_OR_LOCAL7, (match, safe?: string, a?: string, b?: string) => {
      if (safe !== undefined || a === "555") return match;
      return `555-${this.hmacDigits("local7", `${a}${b}`, 4)}`;
    });
    // International numbers: replaced by a fictional +1 555 number.
    out = out.replace(SAFE_OR_INTL, (match, safe?: string) => {
      if (safe !== undefined || digitCount(match) < 9) return match;
      return `+1 555-${this.hmacDigits("intl", match.replace(/\D/g, ""), 4)}`;
    });
    if (this.maskPii) {
      out = out.replace(EMAIL_IN_TEXT, (email) =>
        email.toLowerCase().endsWith(`@${MASKED_EMAIL_DOMAIN}`)
          ? email
          : `user-${this.hmacHex("email", email, 10)}@${MASKED_EMAIL_DOMAIN}`,
      );
    }
    return out;
  }
}

/**
 * Last line of defence: walk the whole export and throw if any string still
 * holds a phone number that is neither masked (555 exchange) nor a known
 * business number. The error names the path but never the digits.
 */
export function assertNoRealPhones(
  value: unknown,
  allowedBusiness: ReadonlySet<string>,
  opts: { maskPii?: boolean } = {},
): void {
  const fail = (what: string, where: string): never => {
    throw new Error(`export contains an unmasked ${what} at ${where}`);
  };
  const walk = (v: unknown, where: string): void => {
    if (typeof v === "string") {
      // Masked-email pseudonyms (user-<10 hex>@example.invalid) can be all digits (~1%) and look like a phone.
      const scrubbed = v.replace(MASKED_EMAIL_TOKEN, (m) => (opts.maskPii ? " " : m)).replace(SAFE_TOKENS, " ");
      for (const m of scrubbed.matchAll(PHONE_IN_TEXT)) {
        const real = `${m[2]}${m[3]}${m[4]}`;
        if (m[3] === "555" || allowedBusiness.has(real)) continue;
        fail("phone number", where);
      }
      for (const m of scrubbed.matchAll(LOCAL7_IN_TEXT)) {
        if (m[1] !== "555") fail("7-digit phone number", where);
      }
      for (const m of scrubbed.matchAll(INTL_IN_TEXT)) {
        if (digitCount(m[0]) >= 9) fail("international phone number", where);
      }
      if (opts.maskPii) {
        for (const m of scrubbed.matchAll(EMAIL_IN_TEXT)) {
          if (!m[0].toLowerCase().endsWith(`@${MASKED_EMAIL_DOMAIN}`)) fail("email address", where);
        }
      }
    } else if (typeof v === "number") {
      if (Number.isSafeInteger(v) && v >= 0) {
        const digits = String(v);
        const real = digits.length === 10 ? digits : digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : null;
        if (real && /^[2-9]/.test(real) && real.slice(3, 6) !== "555" && !allowedBusiness.has(real)) {
          fail("numeric phone number", where);
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${where}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) walk(item, where ? `${where}.${k}` : k);
    }
  };
  walk(value, "");
}
