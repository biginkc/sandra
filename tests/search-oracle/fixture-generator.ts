// Deterministic corpus for the search oracle. Same seed => identical output (incl. ids).
import type { OracleContact, OracleFixture, OracleMembership, OracleMessage, OracleProperty } from "./types";

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function det_uuid(kind: number, n: number): string {
  const hex = (v: number, len: number) => v.toString(16).padStart(len, "0");
  return `${hex(kind, 8)}-0000-4000-8000-${hex(n, 12)}`;
}

export const ORG_A = det_uuid(1, 1);
export const ORG_B = det_uuid(1, 2);
export const USERS = {
  /** active in org A only */ a: det_uuid(2, 1),
  /** active in org B only */ b: det_uuid(2, 2),
  /** active in both orgs */ both: det_uuid(2, 3),
  /** membership expired in org A */ expired: det_uuid(2, 4),
  /** deletion-prepared in org A */ deletionPrepared: det_uuid(2, 5),
  /** suspended in org A */ suspended: det_uuid(2, 6),
  /** no membership at all */ nobody: det_uuid(2, 7),
} as const;

export interface GeneratorOptions { seed?: number; propertyCount?: number; now?: Date }

const COMMON_SURNAMES = ["Smith", "Johnson", "Williams", "Brown", "Jones"]; // skewed: ~45% of contacts
const RARE_SURNAMES = ["O'Brien", "Smith-Jones", "Núñez", "Müller", "D'Angelo", "Zielinski", "Okafor", "Villanueva", "Nakamura", "Kowalczyk", "Fontaine", "Haddad", "Petrov", "Larsen", "Quigley"];
const FIRST = ["Jane", "John", "María", "José", "Anne-Marie", "Robert", "Linda", "Michael", "Patricia", "Dwayne", "Sandra", "Chris", "Priya", "Tomás", "Ellen"];
const ENTITIES = ["Doe Family Trust LLC", "Main Street Holdings", "Estate of Harold Smith", "KC Rentals Inc", "O'Brien & Sons LLC"];
const STREETS = ["Main St", "Oak Ave", "Maple Dr", "N Broadway", "Elm Ct", "Prospect Blvd", "W 47th St", "Ward Pkwy", "Troost Ave", "State Line Rd"];
const CITIES = [["Kansas City", "MO", "64111"], ["Overland Park", "KS", "66204"], ["Independence", "MO", "64050"], ["Lee's Summit", "MO", "64063"], ["Olathe", "KS", "66061"], ["St. Louis", "MO", "63101"]];
const MARKETS = ["kc-metro", "stl", "wichita"];
const STATUSES = ["prospect", "new_lead", "interested", "dead", "closed"];
const WORDS = ["cash", "offer", "price", "tenant", "roof", "foundation", "probate", "callback", "mortgage", "thanks", "stop", "maybe", "december", "inspection", "listing", "wrong", "number", "appointment", "tomorrow", "estimate"];

function phone(r: () => number, fmt: number, base: string): string {
  const a = base.slice(0, 3), b = base.slice(3, 6), c = base.slice(6);
  return [`(${a}) ${b}-${c}`, `${a}.${b}.${c}`, `+1${base}`, `${a}-${b}-${c}`, base, `+1 ${a} ${b} ${c}`][fmt % 6];
}

export function generateFixture(opts: GeneratorOptions = {}): OracleFixture {
  const r = mulberry32(opts.seed ?? 20261002);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const propertyCount = opts.propertyCount ?? 300;
  const now = opts.now ?? new Date("2026-10-02T00:00:00Z");
  const iso = (days: number) => new Date(now.getTime() + days * 86400000).toISOString();

  const properties: OracleProperty[] = [];
  const contacts: OracleContact[] = [];
  const messages: OracleMessage[] = [];
  let cn = 0, mn = 0, convn = 0;

  const newContact = (org: string, agent = false): OracleContact => {
    cn++;
    const entity = !agent && r() < 0.1;
    const last = r() < 0.45 ? pick(COMMON_SURNAMES) : pick(RARE_SURNAMES);
    const first = pick(FIRST);
    const base = String(2000000000 + Math.floor(r() * 7999999999)).slice(0, 10).replace(/^(\d{3})/, (m) => (r() < 0.5 ? "816" : m));
    const c: OracleContact = {
      id: det_uuid(4, cn), org_id: org,
      first_name: entity ? null : first, last_name: entity ? null : last,
      entity_name: entity ? pick(ENTITIES) : null,
      email: r() < 0.7 ? `${(first + "." + last).toLowerCase().replace(/[^a-z.]/g, "")}${cn}@${pick(["gmail.com", "yahoo.com", "brokerage.example", "icloud.com"])}` : null,
      phone_1: r() < 0.9 ? phone(r, Math.floor(r() * 6), base) : null,
      phone_2: r() < 0.3 ? phone(r, Math.floor(r() * 6), String(3000000000 + Math.floor(r() * 6999999999)).slice(0, 10)) : null,
      phone_3: r() < 0.08 ? phone(r, Math.floor(r() * 6), String(4000000000 + Math.floor(r() * 5999999999)).slice(0, 10)) : null,
    };
    if (agent) c.entity_name = r() < 0.5 ? pick(["Keller Williams KC", "RE/MAX Heartland", "Reece & Nichols"]) : null;
    contacts.push(c);
    return c;
  };

  for (let i = 1; i <= propertyCount; i++) {
    const org = i % 5 === 0 ? ORG_B : ORG_A;
    const [city, state, zip] = pick(CITIES);
    const homeowner = r() < 0.92 ? newContact(org) : null;
    const agent = r() < 0.2 ? newContact(org, true) : null;
    const p: OracleProperty = {
      id: det_uuid(3, i), org_id: org,
      address: `${100 + Math.floor(r() * 9800)} ${pick(STREETS)}${r() < 0.1 ? " #" + pick(["2B", "4A", "12"]) : ""}`,
      city, state, zip: r() < 0.97 ? zip : null,
      market: r() < 0.8 ? pick(MARKETS) : null,
      apn: r() < 0.6 ? `${Math.floor(r() * 90) + 10}-${Math.floor(r() * 900) + 100}-${Math.floor(r() * 90) + 10}-00` : null,
      mls_number: r() < 0.3 ? `MLS${2400000 + Math.floor(r() * 99999)}` : null,
      homeowner_contact_id: homeowner?.id ?? null,
      agent_contact_id: agent?.id ?? null,
      deleted_at: r() < 0.05 ? iso(-10) : null,
      is_training: r() < 0.03,
      status: pick(STATUSES),
    };
    properties.push(p);
  }
  // A contact shared by several properties (the "newest property only" trap) and a homeowner who is another property's agent.
  const shared = contacts[0];
  for (const p of properties.slice(10, 14)) if (p.org_id === shared.org_id) p.homeowner_contact_id = shared.id;
  const agentShared = contacts.find((c) => c.org_id === ORG_A && c.id !== shared.id)!;
  for (const p of properties.slice(20, 23)) if (p.org_id === agentShared.org_id) p.agent_contact_id = agentShared.id;
  // Hand-planted rows so fixed queries always have a target (also cross-org duplicates).
  const plant = (org: string, idx: number, patch: Partial<OracleProperty>, contactPatch?: Partial<OracleContact>) => {
    const p = properties[idx];
    Object.assign(p, { org_id: org, deleted_at: null, is_training: false }, patch);
    if (contactPatch) {
      const c = newContact(org);
      Object.assign(c, contactPatch);
      p.homeowner_contact_id = c.id;
    }
  };
  plant(ORG_A, 30, { address: "4821 Wornall Rd", zip: "64112", status: "new_lead" }, { first_name: "Jane", last_name: "Doe", phone_1: "(555) 123-4567", email: "jane.doe@example.com" });
  plant(ORG_B, 31, { address: "4821 Wornall Rd", zip: "64112" }, { first_name: "Jane", last_name: "Doe", phone_1: "555-123-4567" });
  plant(ORG_A, 32, { address: "77 Quincy Ln #2B", status: "dead" }, { entity_name: "Doe Family Trust LLC", first_name: null, last_name: null });
  plant(ORG_A, 33, { address: "10 Zenith Way", deleted_at: iso(-3) }, { first_name: "Deleted", last_name: "Zeppelin" });
  plant(ORG_A, 34, { address: "11 Zenith Way", is_training: true }, { first_name: "Training", last_name: "Zeppelin" });

  // Messages: ~3 per non-deleted-ish property, sms mostly, some email / null conversation.
  for (const p of properties) {
    const n = Math.floor(r() * 5);
    const convId = det_uuid(6, ++convn);
    for (let k = 0; k < n; k++) {
      const channel = r() < 0.85 ? "sms" : pick(["email", "call"]);
      const words = Array.from({ length: 3 + Math.floor(r() * 8) }, () => pick(WORDS));
      if (r() < 0.2) words.push(pick(["$250,000", "3-bed", "O'Brien", "5%", "816-555-0100", "señor"]));
      messages.push({
        id: det_uuid(5, ++mn), org_id: p.org_id, property_id: p.id,
        contact_id: p.homeowner_contact_id, conversation_id: channel === "sms" && r() < 0.95 ? convId : null,
        channel, direction: r() < 0.5 ? "inbound" : "outbound", body: r() < 0.02 ? null : words.join(" "),
      });
    }
  }
  // Fixed message targets.
  const msgTargets: [number, string, string, string | null][] = [
    [40, ORG_A, "sms", "Please send the xylophone appraisal tomorrow"],
    [41, ORG_A, "email", "Please send the xylophone appraisal tomorrow"],
    [42, ORG_A, "sms", "the XYLOPHONE-quartet is 5% done"],
    [43, ORG_B, "sms", "xylophone for org b only"],
  ];
  for (const [idx, org, channel, body] of msgTargets) {
    const p = properties[idx];
    p.org_id = org; p.deleted_at = null;
    messages.push({ id: det_uuid(5, ++mn), org_id: org, property_id: p.id, contact_id: p.homeowner_contact_id, conversation_id: det_uuid(6, ++convn), channel, direction: "inbound", body });
  }
  // sms without conversation_id (must never match)
  messages.push({ id: det_uuid(5, ++mn), org_id: ORG_A, property_id: properties[44].id, contact_id: null, conversation_id: null, channel: "sms", direction: "inbound", body: "xylophone orphan" });
  // message with no property link
  messages.push({ id: det_uuid(5, ++mn), org_id: ORG_A, property_id: null, contact_id: null, conversation_id: det_uuid(6, ++convn), channel: "sms", direction: "inbound", body: "xylophone unlinked" });

  const m = (user: string, org: string, patch: Partial<OracleMembership> = {}): OracleMembership =>
    ({ user_id: user, org_id: org, access_status: "active", access_expires_at: null, deletion_prepared_at: null, ...patch });
  const memberships: OracleMembership[] = [
    m(USERS.a, ORG_A), m(USERS.b, ORG_B), m(USERS.both, ORG_A), m(USERS.both, ORG_B),
    m(USERS.expired, ORG_A, { access_expires_at: iso(-1) }),
    m(USERS.deletionPrepared, ORG_A, { deletion_prepared_at: iso(-1) }),
    m(USERS.suspended, ORG_A, { access_status: "suspended" }),
  ];
  const users = Object.values(USERS).map((id) => ({ id, orgIds: memberships.filter((x) => x.user_id === id).map((x) => x.org_id) }));
  return { properties, contacts, messages, memberships, users };
}
