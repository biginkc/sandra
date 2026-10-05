import "server-only";

import { classifyLegal } from "../normalize";
import { CompProviderError, type CompProvider, type CompSale, type CompSubject, type ProviderCompResult } from "./../types";

/**
 * ATTOM provider (TECH-PLAN §3.2). Two ordered calls per comp:
 *   1. AVM detail (`/propertyapi/v1.0.0/attomavm/detail`, by `attomid` when the lead carries one,
 *      else `address1`/`address2`). Verified against the live API on 2026-10-04: one response
 *      carries `identifier.{attomId,apn,fips}`, `address.oneLine`, `location.{latitude,longitude}`,
 *      `summary.legal1`, `building.size.universalsize`, `building.rooms.{beds,bathstotal}`,
 *      `summary.yearbuilt`, `avm.amount.{value,low,high,scr,fsd}` (fsd is a percent integer) and
 *      `owner.owner1.fullname` / `owner.owner2.fullname`, so a separate property-detail call is
 *      not needed.
 *   2. Sales comparables (`/property/v2/salescomparables/propid/{attomId}`), optional: a 403/404
 *      (entitlement absent on a trial key, or no comps) yields an empty list, never an error.
 * `billedCalls` counts every HTTP request actually sent. The key is read once from the caller
 * (`ATTOM_API_KEY`) and never logged.
 */
export type AttomProviderOptions = {
  apiKey: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout; the plan's default is 8 s. */
  requestTimeoutMs?: number;
};

export const ATTOM_AVM_PATH = "/propertyapi/v1.0.0/attomavm/detail";
export const ATTOM_COMPS_PATH = "/property/v2/salescomparables/propid";

type Json = Record<string, unknown>;
const isRecord = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const get = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((acc, key) => (isRecord(acc) ? acc[key] : undefined), o);

export function subjectAddressParams(subject: CompSubject): { address1: string; address2: string } | null {
  const address1 = subject.address?.trim();
  const city = subject.city?.trim();
  const state = subject.state?.trim();
  if (!address1 || !state) return null;
  const address2 = [city, [state, subject.zip?.trim()].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return { address1, address2 };
}

/** Owner of record from the AVM payload: owner1 (and owner2) full names, joined. */
export function mapOwner(property: Json): string | null {
  const names = ["owner1", "owner2"]
    .map((key) => {
      const o = get(property, `owner.${key}`);
      if (!isRecord(o)) return null;
      return str(o.fullname) ?? ([str(o.firstnameandmi), str(o.lastname)].filter(Boolean).join(" ") || null);
    })
    .filter((n): n is string => !!n);
  return names.length ? names.join(" & ") : null;
}

/**
 * Legal description: `summary.legal1` when present; else subdivision + lot number only when both
 * exist (a subdivision alone is never a legal description). Completeness via `classifyLegal`.
 */
export function mapLegal(property: Json): { text: string | null; complete: boolean } {
  const legal1 = str(get(property, "summary.legal1"));
  if (legal1) return classifyLegal(legal1);
  const subd = str(get(property, "area.subdname"));
  const lot = str(get(property, "lot.lotnum"));
  if (subd && lot) return classifyLegal(`${subd} LOT ${lot}`);
  return { text: null, complete: false };
}

export function mapAvmDetail(body: unknown): Omit<ProviderCompResult, "comps" | "billedCalls" | "raw"> & { attomId: string | null } {
  const property = get(body, "property");
  if (!Array.isArray(property)) throw new CompProviderError("INVALID_RESPONSE", 0);
  if (property.length === 0 || !isRecord(property[0])) throw new CompProviderError("NOT_FOUND", 0);
  const p = property[0];
  const attomId = str(get(p, "identifier.attomId"));
  const amount = get(p, "avm.amount");
  const asIs = isRecord(amount)
    ? { value: num(amount.value), low: num(amount.low), high: num(amount.high), score: num(amount.scr), fsdPct: num(amount.fsd) }
    : { value: null, low: null, high: null, score: null, fsdPct: null };
  if (asIs.value !== null && asIs.fsdPct === null && asIs.low !== null && asIs.high !== null && asIs.value > 0) {
    asIs.fsdPct = ((asIs.high - asIs.low) / 2 / asIs.value) * 100;
  }
  return { providerPropertyId: attomId, attomId, asIs, ownerOfRecord: mapOwner(p), legal: mapLegal(p) };
}

/** Sales comparables mapper. The comparables shape is NOT yet verified against a live key (trial
 * entitlement pending); this reads the documented fields defensively and drops malformed rows. */
export function mapComparables(body: unknown): CompSale[] {
  const candidates: unknown[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 6) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (!isRecord(v)) return;
    if (isRecord(v.sale) || isRecord(v.saleAmount) || v.salePrice !== undefined) candidates.push(v);
    for (const key of Object.keys(v)) if (key !== "sale") walk(v[key], depth + 1);
  };
  walk(body, 0);
  const out: CompSale[] = [];
  for (const c of candidates) {
    if (!isRecord(c)) continue;
    const salePrice = num(get(c, "sale.amount.saleamt")) ?? num(get(c, "saleAmount.saleAmt")) ?? num(c.salePrice);
    const saleDate = str(get(c, "sale.amount.salerecdate")) ?? str(get(c, "sale.saleTransDate")) ?? str(get(c, "saleAmount.saleRecDate")) ?? str(c.saleDate);
    const address = str(get(c, "address.oneLine")) ?? str(c.address);
    if (salePrice === null || salePrice <= 0 || !saleDate || !address) continue;
    out.push({
      address,
      saleDate,
      salePrice,
      sqft: num(get(c, "building.size.universalsize")) ?? num(get(c, "building.size.livingsize")) ?? num(c.sqft),
      beds: num(get(c, "building.rooms.beds")) ?? num(c.beds),
      baths: num(get(c, "building.rooms.bathstotal")) ?? num(c.baths),
      yearBuilt: num(get(c, "summary.yearbuilt")) ?? num(c.yearBuilt),
      distanceMiles: num(get(c, "location.distance")) ?? num(c.distance),
      providerId: str(get(c, "identifier.attomId")) ?? str(get(c, "identifier.Id")),
      renovatedHint: null,
    });
  }
  return out;
}

function retryAfterSeconds(res: Response): number | undefined {
  const header = res.headers.get("retry-after");
  if (!header) return undefined;
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function createAttomProvider(opts: AttomProviderOptions): CompProvider {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.requestTimeoutMs ?? 8000;
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers = { apikey: opts.apiKey, accept: "application/json" };

  async function call(path: string, params: Record<string, string>, outer: AbortSignal, billed: { n: number }): Promise<{ status: number; body: unknown; res: Response }> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const signal = AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]);
    billed.n += 1;
    let res: Response;
    try {
      res = await fetchImpl(url, { headers, signal });
    } catch (error) {
      if (outer.aborted || (error instanceof Error && error.name === "TimeoutError")) throw new CompProviderError("TIMEOUT", billed.n);
      if (error instanceof Error && error.name === "AbortError") throw new CompProviderError("TIMEOUT", billed.n);
      throw new CompProviderError("UPSTREAM", billed.n);
    }
    let body: unknown = null;
    const text = await res.text().catch(() => "");
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        if (res.ok) throw new CompProviderError("INVALID_RESPONSE", billed.n);
      }
    }
    return { status: res.status, body, res };
  }

  return {
    name: "attom",
    callsPerComp: 2,
    async fetch(subject, signal) {
      const billed = { n: 0 };
      const params = subject.attomId ? { attomid: subject.attomId } : subjectAddressParams(subject);
      if (!params) throw new CompProviderError("NOT_FOUND", 0);

      const avm = await call(ATTOM_AVM_PATH, params, signal, billed);
      if (avm.status === 401 || avm.status === 403) throw new CompProviderError("AUTH", billed.n);
      if (avm.status === 429) throw new CompProviderError("RATE_LIMIT", billed.n, retryAfterSeconds(avm.res));
      if (avm.status === 404) throw new CompProviderError("NOT_FOUND", billed.n);
      if (avm.status >= 500) throw new CompProviderError("UPSTREAM", billed.n);
      if (avm.status !== 200 || avm.body === null) throw new CompProviderError("INVALID_RESPONSE", billed.n);
      let mapped: ReturnType<typeof mapAvmDetail>;
      try {
        mapped = mapAvmDetail(avm.body);
      } catch (error) {
        if (error instanceof CompProviderError) throw new CompProviderError(error.code, billed.n);
        throw new CompProviderError("INVALID_RESPONSE", billed.n);
      }

      let comps: CompSale[] = [];
      let compsStatus: string = "skipped_no_attom_id";
      if (mapped.attomId) {
        const cmp = await call(`${ATTOM_COMPS_PATH}/${encodeURIComponent(mapped.attomId)}`, {
          searchType: "Radius", miles: "1", minComps: "3", maxComps: "10", saleDateRange: "12",
          bedroomsRange: "1", bathroomsRange: "1", sqFeetRange: "500",
        }, signal, billed);
        if (cmp.status === 429) throw new CompProviderError("RATE_LIMIT", billed.n, retryAfterSeconds(cmp.res));
        if (cmp.status >= 500) throw new CompProviderError("UPSTREAM", billed.n);
        if (cmp.status === 200 && cmp.body !== null) {
          comps = mapComparables(cmp.body);
          compsStatus = "ok";
        } else {
          // 401/403 on comps alone = entitlement absent on this key; 404 = none found.
          compsStatus = cmp.status === 401 || cmp.status === 403 ? "not_entitled" : cmp.status === 404 ? "none" : `http_${cmp.status}`;
        }
      }

      return {
        providerPropertyId: mapped.providerPropertyId,
        asIs: mapped.asIs,
        comps,
        ownerOfRecord: mapped.ownerOfRecord,
        legal: mapped.legal,
        billedCalls: billed.n,
        raw: { avm: avm.body as Record<string, unknown>, compsStatus },
      };
    },
  };
}
