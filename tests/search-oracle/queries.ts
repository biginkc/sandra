import type { OracleFixture, OracleQuery } from "./types";
import { mulberry32 } from "./fixture-generator";

export interface OracleCase extends OracleQuery { label: string }

const c = (label: string, q: string, includeMessages = true): OracleCase => ({ label, q, includeMessages });

/** 30 fast queries for CI. Targets are planted by generateFixture(). */
export const CI_QUERIES: OracleCase[] = [
  c("full name", "jane doe"), c("name upper", "JANE DOE"), c("first only", "jane"), c("partial last", "smi"),
  c("common surname", "smith"), c("hyphen", "smith-jones"), c("apostrophe", "o'brien"), c("accent", "núñez"),
  c("entity", "doe family trust"), c("email partial", "jane.doe@"), c("email domain", "gmail"),
  c("phone paren", "(555) 123-4567"), c("phone dots", "555.123.4567"), c("phone +1", "+1 555 123 4567"),
  c("phone last4", "4567"), c("phone area", "816"), c("short phone", "55"),
  c("zip", "64112"), c("street number", "4821"), c("street", "wornall"), c("unit", "#2b"), c("apn-ish", "00"),
  c("mls", "mls24"), c("msg word", "xylophone"), c("msg word no msgs", "xylophone", false), c("msg two words", "xylophone appraisal"),
  c("msg prefix", "xyloph"),
  c("planted deleted+training rows", "zeppelin"), c("planted deleted address", "zenith way"), c("pct hostile", "%"), c("underscore hostile", "___"), c("tsquery hostile", "a:* & !b | (c)"),
];

const HOSTILE = ["%", "_", "\\", "'", '"', ",", "()", "or(", ":*", "&|!", "'; drop table properties;--", "😀😀😀", "   ", "a".repeat(500), "%%%", "\\\\\\", "x:*y", "((", "a,b,c", "é́é"];

/** 200 queries: the CI set + generated from the fixture's own values so most have hits. Deterministic. */
export function localQueries(fixture: OracleFixture, seed = 7): OracleCase[] {
  const r = mulberry32(seed);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const out: OracleCase[] = [...CI_QUERIES];
  const cut = (s: string, lo = 3) => s.slice(0, Math.max(lo, 1 + Math.floor(r() * s.length)));
  const gen: (() => OracleCase | null)[] = [
    () => { const k = pick(fixture.contacts); return k.last_name ? c("last name", k.last_name) : null; },
    () => { const k = pick(fixture.contacts); return k.first_name && k.last_name ? c("full name", `${k.first_name} ${k.last_name}`.toLowerCase()) : null; },
    () => { const k = pick(fixture.contacts); return k.last_name ? c("partial last", cut(k.last_name)) : null; },
    () => { const k = pick(fixture.contacts); return k.entity_name ? c("entity", cut(k.entity_name, 4)) : null; },
    () => { const k = pick(fixture.contacts); return k.email ? c("email", cut(k.email, 4)) : null; },
    () => { const k = pick(fixture.contacts); return k.phone_1 ? c("phone fmt", k.phone_1) : null; },
    () => { const k = pick(fixture.contacts); const d = (k.phone_2 ?? k.phone_1 ?? "").replace(/\D/g, ""); return d ? c("last4", d.slice(-4)) : null; },
    () => { const k = pick(fixture.contacts); const d = (k.phone_3 ?? k.phone_1 ?? "").replace(/\D/g, ""); return d.length >= 7 ? c("mid digits", d.slice(2, 2 + 3 + Math.floor(r() * 5))) : null; },
    () => { const p = pick(fixture.properties); return p.zip ? c("zip", p.zip) : null; },
    () => { const p = pick(fixture.properties); return p.address ? c("street number", p.address.split(" ")[0]) : null; },
    () => { const p = pick(fixture.properties); return p.address ? c("address", cut(p.address.toUpperCase(), 4)) : null; },
    () => { const p = pick(fixture.properties); return p.city ? c("city", cut(p.city)) : null; },
    () => { const p = pick(fixture.properties); return p.apn ? c("apn", cut(p.apn, 4)) : null; },
    () => { const p = pick(fixture.properties); return p.mls_number ? c("mls", p.mls_number.toLowerCase()) : null; },
    () => { const m = pick(fixture.messages); return m.body ? c("msg word", cut(pick(m.body.split(/\s+/)), 3)) : null; },
    () => { const m = pick(fixture.messages); const w = (m.body ?? "").split(/\s+/); return w.length > 1 ? c("msg words", `${w[0]} ${cut(w[1], 3)}`, r() < 0.8) : null; },
    () => c("hostile", pick(HOSTILE), r() < 0.8),
    () => c("msg no-include", pick(["cash", "offer", "roof", "probate", "tenant"]), false),
  ];
  let guard = 0;
  while (out.length < 200 && guard++ < 5000) {
    const q = pick(gen)();
    if (q) out.push(q);
  }
  return out;
}
