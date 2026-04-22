/**
 * In-process, zero-dependency normalizers used at ingest.
 * All functions return either a canonical string or null; they never throw.
 *
 * When we swap to a CASS provider (SmartyStreets / Lob), `normalizeAddress`
 * gets superseded by the provider's standardized output, but the signature
 * stays identical. The dedup column `properties.address_normalized` stores
 * the output of whatever implementation is live at ingest time.
 */

// ---------- Street suffix canonicalization (USPS Pub 28 subset) -----------

// Map of ANY variant → canonical short form.
// Covers the suffixes that actually appear in DealMachine/Zillow/MLS exports
// across BMH's four markets. Extend as new variants show up.
const STREET_SUFFIX: Record<string, string> = {
  // Alley
  alley: "aly", aly: "aly",
  // Arcade
  arcade: "arc", arc: "arc",
  // Avenue
  avenue: "ave", ave: "ave", av: "ave", aven: "ave", avn: "ave", avnue: "ave",
  // Bend
  bend: "bnd", bnd: "bnd",
  // Boulevard
  boulevard: "blvd", blvd: "blvd", boul: "blvd", boulv: "blvd",
  // Branch
  branch: "br", br: "br",
  // Bridge
  bridge: "brg", brg: "brg",
  // Brook
  brook: "brk", brk: "brk",
  // Bypass
  bypass: "byp", byp: "byp",
  // Causeway
  causeway: "cswy", cswy: "cswy",
  // Center
  center: "ctr", centre: "ctr", ctr: "ctr", cen: "ctr", cent: "ctr",
  // Circle
  circle: "cir", cir: "cir", circ: "cir", crcl: "cir", crcle: "cir",
  // Common / Commons
  common: "cmn", cmn: "cmn", commons: "cmns", cmns: "cmns",
  // Corner / Corners
  corner: "cor", cor: "cor", corners: "cors", cors: "cors",
  // Course / Court / Courts / Cove / Coves
  course: "crse", crse: "crse",
  court: "ct", ct: "ct", courts: "cts", cts: "cts",
  cove: "cv", cv: "cv", coves: "cvs", cvs: "cvs",
  // Creek / Crescent / Crest / Crossing / Crossroad
  creek: "crk", crk: "crk",
  crescent: "cres", cres: "cres",
  crest: "crst", crst: "crst",
  crossing: "xing", xing: "xing", crssng: "xing",
  crossroad: "xrd", xrd: "xrd",
  // Drive(s)
  drive: "dr", dr: "dr", drv: "dr", driv: "dr",
  drives: "drs", drs: "drs",
  // Estate(s), Expressway, Extension(s)
  estate: "est", est: "est", estates: "ests", ests: "ests",
  expressway: "expy", expy: "expy", exp: "expy", expr: "expy", expw: "expy",
  extension: "ext", ext: "ext", extn: "ext", extnsn: "ext",
  extensions: "exts", exts: "exts",
  // Falls, Ferry, Field(s), Flat(s), Ford(s), Forest, Forge(s), Fork(s)
  falls: "fls", fls: "fls",
  ferry: "fry", fry: "fry", frry: "fry",
  field: "fld", fld: "fld", fields: "flds", flds: "flds",
  flat: "flt", flt: "flt", flats: "flts", flts: "flts",
  ford: "frd", frd: "frd", fords: "frds", frds: "frds",
  forest: "frst", forests: "frst", frst: "frst",
  forge: "frg", frg: "frg", forges: "frgs", frgs: "frgs",
  fork: "frk", frk: "frk", forks: "frks", frks: "frks",
  // Fort, Freeway
  fort: "ft", ft: "ft", frt: "ft",
  freeway: "fwy", fwy: "fwy", frwy: "fwy", frway: "fwy",
  // Garden(s), Gateway, Glen(s), Green(s), Grove(s)
  garden: "gdn", gdn: "gdn", grden: "gdn", grdn: "gdn",
  gardens: "gdns", gdns: "gdns", grdns: "gdns",
  gateway: "gtwy", gtwy: "gtwy", gtway: "gtwy",
  glen: "gln", gln: "gln", glens: "glns", glns: "glns",
  green: "grn", grn: "grn", greens: "grns", grns: "grns",
  grove: "grv", grv: "grv", grov: "grv",
  groves: "grvs", grvs: "grvs",
  // Harbor(s), Haven, Heights, Highway, Hill(s), Hollow
  harbor: "hbr", hbr: "hbr", harb: "hbr", harbr: "hbr",
  harbors: "hbrs", hbrs: "hbrs",
  haven: "hvn", hvn: "hvn",
  heights: "hts", hts: "hts", ht: "hts",
  highway: "hwy", hwy: "hwy", highwy: "hwy", hiway: "hwy", hway: "hwy",
  hill: "hl", hl: "hl", hills: "hls", hls: "hls",
  hollow: "holw", holw: "holw", hollows: "holw",
  // Island(s), Isle, Junction(s)
  island: "is", is: "is", islnd: "is",
  islands: "iss", iss: "iss", islnds: "iss",
  isle: "isle", isles: "isle",
  junction: "jct", jct: "jct", jctn: "jct",
  junctions: "jcts", jcts: "jcts",
  // Key(s), Knoll(s)
  key: "ky", ky: "ky", keys: "kys", kys: "kys",
  knoll: "knl", knl: "knl", knolls: "knls", knls: "knls",
  // Lake(s), Landing, Lane, Light(s), Loaf, Lock(s), Lodge, Loop
  lake: "lk", lk: "lk", lakes: "lks", lks: "lks",
  landing: "lndg", lndg: "lndg", lndng: "lndg",
  lane: "ln", ln: "ln",
  light: "lgt", lgt: "lgt", lights: "lgts", lgts: "lgts",
  loaf: "lf", lf: "lf",
  lock: "lck", lck: "lck", locks: "lcks", lcks: "lcks",
  lodge: "ldg", ldg: "ldg", ldge: "ldg", lodg: "ldg",
  loop: "loop", loops: "loop",
  // Manor(s), Meadow(s), Mews, Mill(s), Mission, Motorway, Mount, Mountain(s)
  manor: "mnr", mnr: "mnr", manors: "mnrs", mnrs: "mnrs",
  meadow: "mdw", mdw: "mdw", meadows: "mdws", mdws: "mdws",
  mews: "mews",
  mill: "ml", ml: "ml", mills: "mls", mls: "mls",
  mission: "msn", msn: "msn", missn: "msn",
  motorway: "mtwy", mtwy: "mtwy",
  mount: "mt", mt: "mt", mnt: "mt",
  mountain: "mtn", mtn: "mtn", mntn: "mtn", mountin: "mtn",
  mountains: "mtns", mtns: "mtns", mntns: "mtns",
  // Neck, Orchard, Oval, Overpass
  neck: "nck", nck: "nck",
  orchard: "orch", orch: "orch", orchrd: "orch",
  oval: "oval", ovl: "oval",
  overpass: "opas", opas: "opas",
  // Park(s), Parkway(s), Pass, Passage, Path, Pike, Pine(s), Place, Plain(s), Plaza, Point(s), Port(s), Prairie
  park: "park", prk: "park",
  parks: "parks",
  parkway: "pkwy", pkwy: "pkwy", pkway: "pkwy", pky: "pkwy", parkwy: "pkwy",
  parkways: "pkwys", pkwys: "pkwys",
  pass: "pass",
  passage: "psge", psge: "psge",
  path: "path", paths: "path",
  pike: "pike", pikes: "pike",
  pine: "pne", pne: "pne", pines: "pnes", pnes: "pnes",
  place: "pl", pl: "pl",
  plain: "pln", pln: "pln", plains: "plns", plns: "plns",
  plaza: "plz", plz: "plz", plza: "plz",
  point: "pt", pt: "pt", points: "pts", pts: "pts",
  port: "prt", prt: "prt", ports: "prts", prts: "prts",
  prairie: "pr", pr: "pr", prr: "pr",
  // Radial, Ramp, Ranch, Rapid(s), Rest, Ridge(s), River, Road(s), Route, Row, Run
  radial: "radl", radl: "radl", rad: "radl",
  ramp: "ramp",
  ranch: "rnch", rnch: "rnch", ranches: "rnch", rnchs: "rnch",
  rapid: "rpd", rpd: "rpd", rapids: "rpds", rpds: "rpds",
  rest: "rst", rst: "rst",
  ridge: "rdg", rdg: "rdg", rdge: "rdg",
  ridges: "rdgs", rdgs: "rdgs",
  river: "riv", riv: "riv", rvr: "riv", rivr: "riv",
  road: "rd", rd: "rd",
  roads: "rds", rds: "rds",
  route: "rte", rte: "rte",
  row: "row",
  rue: "rue",
  run: "run",
  // Shoal(s), Shore(s), Skyway, Spring(s), Spur(s), Square(s), Station, Stream, Street(s), Summit
  shoal: "shl", shl: "shl", shoals: "shls", shls: "shls",
  shore: "shr", shr: "shr", shoar: "shr",
  shores: "shrs", shrs: "shrs", shoars: "shrs",
  skyway: "skwy", skwy: "skwy",
  spring: "spg", spg: "spg", spng: "spg", sprng: "spg",
  springs: "spgs", spgs: "spgs", spngs: "spgs", sprngs: "spgs",
  spur: "spur", spurs: "spur",
  square: "sq", sq: "sq", sqr: "sq", sqre: "sq",
  squares: "sqs", sqs: "sqs", sqrs: "sqs",
  station: "sta", sta: "sta", statn: "sta", stn: "sta",
  stream: "strm", strm: "strm", streme: "strm",
  street: "st", st: "st", str: "st", strt: "st",
  streets: "sts", sts: "sts",
  summit: "smt", smt: "smt", sumit: "smt",
  // Terrace, Throughway, Trace, Track(s), Trafficway, Trail(s), Trailer, Tunnel, Turnpike
  terrace: "ter", ter: "ter", terr: "ter",
  throughway: "trwy", trwy: "trwy",
  trace: "trce", trce: "trce",
  track: "trak", trak: "trak", trk: "trak", tracks: "trak", trks: "trak",
  trafficway: "trfy", trfy: "trfy",
  trail: "trl", trl: "trl", tr: "trl",
  trails: "trl", trls: "trl",
  trailer: "trlr", trlr: "trlr",
  tunnel: "tunl", tunl: "tunl", tunnels: "tunl", tunls: "tunl",
  turnpike: "tpke", tpke: "tpke", trnpk: "tpke", turnpk: "tpke",
  // Underpass, Union(s), Valley(s), Viaduct, View(s), Village(s), Ville, Vista, Walk(s), Wall, Way(s), Well(s)
  underpass: "upas", upas: "upas",
  union: "un", un: "un", unions: "uns", uns: "uns",
  valley: "vly", vly: "vly", vlly: "vly", vally: "vly",
  valleys: "vlys", vlys: "vlys",
  viaduct: "via", via: "via", vdct: "via",
  view: "vw", vw: "vw", views: "vws", vws: "vws",
  village: "vlg", vlg: "vlg", vill: "vlg", villag: "vlg", villg: "vlg",
  villages: "vlgs", vlgs: "vlgs",
  ville: "vl", vl: "vl",
  vista: "vis", vis: "vis", vist: "vis", vst: "vis", vsta: "vis",
  walk: "walk", walks: "walk",
  wall: "wall",
  way: "way", wy: "way",
  ways: "ways",
  well: "wl", wl: "wl", wells: "wls", wls: "wls",
};

// ---------- Unit designators -----------

// "apt" is the canonical form for the apt/unit/suite/# family. Real-world
// CSV sources use these interchangeably for the same unit, so we collapse
// them for dedup. Semantically distinct designators (floor, building,
// basement, room, lot, space, penthouse, trailer) keep their own form
// since they describe different structural features.
const UNIT_DESIGNATOR: Record<string, string> = {
  apt: "apt", apartment: "apt",
  unit: "apt",
  ste: "apt", suite: "apt",
  "#": "apt",
  no: "apt", num: "apt",
  fl: "fl", floor: "fl",
  bldg: "bldg", building: "bldg",
  rm: "rm", room: "rm",
  lot: "lot",
  spc: "spc", space: "spc",
  ph: "ph", penthouse: "ph",
  bsmt: "bsmt", basement: "bsmt",
  trlr: "trlr",
};

// ---------- Directionals -----------

const DIRECTIONAL: Record<string, string> = {
  n: "n", north: "n",
  s: "s", south: "s",
  e: "e", east: "e",
  w: "w", west: "w",
  ne: "ne", northeast: "ne",
  nw: "nw", northwest: "nw",
  se: "se", southeast: "se",
  sw: "sw", southwest: "sw",
};

// ---------- Public API -----------

/**
 * Classify why a combined-address string won't parse. Used to produce
 * specific validation errors instead of the catch-all "could not derive"
 * message — e.g. DealMachine Skipped exports often include rows like
 * "Weston, Mo 64098" where the skip-trace found a city but no street.
 * Those aren't parser bugs; they're genuinely unusable as property leads.
 */
export function classifyAddressFullFailure(
  raw: string | null | undefined,
): "empty" | "no_street" | "malformed" {
  if (raw == null) return "empty";
  const trimmed = String(raw).trim();
  if (!trimmed) return "empty";
  // One-or-zero-comma shapes like "Weston, MO 64098" or ", MO" carry at
  // most city/state/zip — no street component possible.
  if (trimmed.split(",").length < 3) return "no_street";
  return "malformed";
}

/**
 * Split a combined-address string (e.g. DealMachine Skipped's
 * `associated_property_address_full`) into its four parts. Targets the
 * canonical USPS-ish shape `"123 Main St, Kansas City, MO 64108"` plus the
 * unit variant `"123 Main St Apt 4, Kansas City, MO 64108-1234"`.
 *
 * Returns null if the string doesn't have two commas + a trailing
 * STATE + ZIP — caller falls back to per-field mapping.
 *
 * This is a best-effort regex. The proper solution is SmartyStreets' US
 * Extract endpoint; that arrives with the CASS flow. Once CASS_ENABLED,
 * the parsed components get overwritten by the verifier anyway.
 */
export function parseFullAddress(
  raw: string | null | undefined,
): { address: string; city: string; state: string; zip: string } | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // "address1, city, ST zip" or "address1, city, ST zip-plus4".
  // Allows extra whitespace, optional trailing country, missing ZIP+4.
  const match = trimmed.match(
    /^(.+?),\s*([^,]+?),\s*([A-Za-z]{2})\s+(\d{5}(?:-\d{4})?)\s*(?:,\s*USA?)?\s*$/,
  );
  if (!match) return null;

  const [, address, city, state, zip] = match;
  return {
    address: address.trim(),
    city: city.trim(),
    state: state.toUpperCase(),
    zip,
  };
}

export function normalizeAddress(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  // Lowercase, strip general punctuation, split `#` off from its attached
  // number (so `#4B` tokenizes as `#` + `4B`), collapse whitespace.
  const cleaned = trimmed
    .toLowerCase()
    .replace(/[.,;:!?"'()\[\]<>]/g, " ")
    .replace(/#/g, " # ")
    .replace(/\s+/g, " ")
    .trim();

  const tokens = cleaned.split(" ");
  const canonical: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    // Street suffix canonicalization
    if (STREET_SUFFIX[token]) {
      canonical.push(STREET_SUFFIX[token]);
      continue;
    }

    // Directional canonicalization
    if (DIRECTIONAL[token]) {
      canonical.push(DIRECTIONAL[token]);
      continue;
    }

    // Unit designator canonicalization
    if (UNIT_DESIGNATOR[token]) {
      canonical.push(UNIT_DESIGNATOR[token]);
      continue;
    }

    canonical.push(token);
  }

  return canonical.join(" ");
}

// ---------- Phone -----------

/**
 * Normalize to E.164-ish format. US 10-digit or 11-digit (with leading 1) only.
 * Returns null for anything else — dedup deliberately doesn't match garbage.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+1${digits.slice(1)}`;
  if (digits.length === 10) return `+1${digits}`;
  return null;
}

// ---------- ZIP -----------

/**
 * Returns either a 5-digit ZIP, a ZIP+4 as "12345-6789", or null.
 * DealMachine often returns trailing ".0" from spreadsheet coercion; stripped.
 */
export function normalizeZip(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (digits.length === 5) return digits;
  if (digits.length === 9) return `${digits.slice(0, 5)}-${digits.slice(5)}`;
  if (digits.length === 4) return digits.padStart(5, "0"); // lost leading zero
  return null;
}

// ---------- APN -----------

/**
 * Strip separators and obvious prefixes. Keeps the original case / alpha chars
 * that many counties use (e.g. `R1234567.01` → `r1234567.01` → `r123456701`).
 * Dedup via (fips_code, apn_normalized) is only useful when fips_code is known.
 */
export function normalizeApn(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = String(raw)
    .trim()
    .toLowerCase()
    .replace(/[\s\-_.]/g, "")
    .replace(/^(apn|pin|parcel|parcelid|pid)/, "");
  return cleaned.length > 0 ? cleaned : null;
}

// ---------- Scalar coercions -----------

export function toNumberOrNull(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const cleaned =
    typeof raw === "string" ? raw.replace(/[$,_\s]/g, "") : String(raw);
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function toIntOrNull(raw: unknown): number | null {
  const n = toNumberOrNull(raw);
  return n == null ? null : Math.trunc(n);
}

export function toBoolOrNull(raw: unknown): boolean | null {
  if (raw == null || raw === "") return null;
  if (typeof raw === "boolean") return raw;
  const s = String(raw).trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(s)) return true;
  if (["false", "f", "no", "n", "0"].includes(s)) return false;
  return null;
}

export function toStringOrNull(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length > 0 ? s : null;
}

// ---------- State code normalizer (for FIPS lookup) -----------

const STATE_CODE: Record<string, string> = {
  alabama: "AL", al: "AL",
  alaska: "AK", ak: "AK",
  arizona: "AZ", az: "AZ",
  arkansas: "AR", ar: "AR",
  california: "CA", ca: "CA",
  colorado: "CO", co: "CO",
  connecticut: "CT", ct: "CT",
  delaware: "DE", de: "DE",
  "district of columbia": "DC", dc: "DC",
  florida: "FL", fl: "FL",
  georgia: "GA", ga: "GA",
  hawaii: "HI", hi: "HI",
  idaho: "ID", id: "ID",
  illinois: "IL", il: "IL",
  indiana: "IN", in: "IN",
  iowa: "IA", ia: "IA",
  kansas: "KS", ks: "KS",
  kentucky: "KY", ky: "KY",
  louisiana: "LA", la: "LA",
  maine: "ME", me: "ME",
  maryland: "MD", md: "MD",
  massachusetts: "MA", ma: "MA",
  michigan: "MI", mi: "MI",
  minnesota: "MN", mn: "MN",
  mississippi: "MS", ms: "MS",
  missouri: "MO", mo: "MO",
  montana: "MT", mt: "MT",
  nebraska: "NE", ne: "NE",
  nevada: "NV", nv: "NV",
  "new hampshire": "NH", nh: "NH",
  "new jersey": "NJ", nj: "NJ",
  "new mexico": "NM", nm: "NM",
  "new york": "NY", ny: "NY",
  "north carolina": "NC", nc: "NC",
  "north dakota": "ND", nd: "ND",
  ohio: "OH", oh: "OH",
  oklahoma: "OK", ok: "OK",
  oregon: "OR", or: "OR",
  pennsylvania: "PA", pa: "PA",
  "rhode island": "RI", ri: "RI",
  "south carolina": "SC", sc: "SC",
  "south dakota": "SD", sd: "SD",
  tennessee: "TN", tn: "TN",
  texas: "TX", tx: "TX",
  utah: "UT", ut: "UT",
  vermont: "VT", vt: "VT",
  virginia: "VA", va: "VA",
  washington: "WA", wa: "WA",
  "west virginia": "WV", wv: "WV",
  wisconsin: "WI", wi: "WI",
  wyoming: "WY", wy: "WY",
};

export function normalizeStateCode(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const key = String(raw).trim().toLowerCase();
  return STATE_CODE[key] ?? null;
}

// ---------- County name normalizer (strip "County"/"Parish" suffixes) -----------

export function normalizeCountyName(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = String(raw)
    .trim()
    .toLowerCase()
    .replace(/\s+(county|parish|borough)$/i, "")
    .trim();
  return cleaned.length > 0 ? cleaned : null;
}
