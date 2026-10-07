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

  /** Replace every phone number inside free text; everything else is verbatim. */
  maskText(text: string): string {
    return text.replace(PHONE_IN_TEXT, (match, prefix: string | undefined, a: string, b: string, c: string) => {
      const real = `${a}${b}${c}`;
      if (this.keep.has(real)) return match;
      const masked = this.mask(real);
      if (!masked) return match;
      const m10 = masked.slice(2);
      return `${prefix ?? ""}${m10.slice(0, 3)}-${m10.slice(3, 6)}-${m10.slice(6)}`;
    });
  }
}

/**
 * Last line of defence: walk the whole export and throw if any string still
 * holds a phone number that is neither masked (555 exchange) nor a known
 * business number. The error names the path but never the digits.
 */
export function assertNoRealPhones(value: unknown, allowedBusiness: ReadonlySet<string>): void {
  const walk = (v: unknown, where: string): void => {
    if (typeof v === "string") {
      const scrubbed = v.replace(SAFE_TOKENS, " ");
      for (const m of scrubbed.matchAll(PHONE_IN_TEXT)) {
        const real = `${m[2]}${m[3]}${m[4]}`;
        if (m[3] === "555" || allowedBusiness.has(real)) continue;
        throw new Error(`export contains an unmasked phone number at ${where}`);
      }
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${where}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, item] of Object.entries(v)) walk(item, where ? `${where}.${k}` : k);
    }
  };
  walk(value, "");
}
