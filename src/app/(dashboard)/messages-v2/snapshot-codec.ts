/** contextErrors marker: the fresh version check failed; the column pauses actions until a re-check succeeds. */
export const SEEN_CHECK_FAILED = "version check";

import type { SnapshotEntry, WaitingSnapshot } from "./hold-list";

/**
 * Compact wire form of the waiting-list snapshot (it is serialized into the page for every hold).
 * Lossless: decode(encode(s)) deep-equals s. Uuids lose their hyphens; instants that round-trip exactly become
 * microsecond epoch integers (anything else stays a string); `f` is omitted when the flag time equals `a`;
 * null / absent fields are omitted.
 */
export type CompactEntry = {
  i: string;
  r?: number;
  a?: number | string;
  f?: number | string | null;
  u?: string;
  t?: number | string;
  d?: string;
  s?: 1;
  /** Display reason index, only when it differs from `r`. */
  x?: number;
};
export type CompactSnapshot = { v: 1; reasons: string[]; rows: CompactEntry[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const packId = (id: string) => (UUID.test(id) ? id.replace(/-/g, "") : `~${id}`);
const unpackId = (s: string) =>
  s.startsWith("~") ? s.slice(1) : HEX32.test(s) ? `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}` : s;

/** "YYYY-MM-DDTHH:MM:SS.ffffffZ" from microseconds since the epoch. */
function microsToInstant(us: number): string {
  const ms = Math.floor(us / 1000);
  const sub = String(us - ms * 1000).padStart(3, "0");
  return `${new Date(ms).toISOString().slice(0, 23)}${sub}Z`;
}
function packTime(v: string): number | string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{6})Z$/.exec(v);
  if (m) {
    const us = Date.parse(`${m[1]}.000Z`) * 1000 + Number(m[2]);
    if (Number.isSafeInteger(us) && microsToInstant(us) === v) return us;
  }
  return v;
}
const unpackTime = (v: number | string) => (typeof v === "number" ? microsToInstant(v) : v);

export function encodeSnapshot(s: WaitingSnapshot): CompactSnapshot {
  const rows = s.entries.map((e): CompactEntry => {
    const row: CompactEntry = { i: packId(e.id) };
    if (e.r !== -1) row.r = e.r;
    if (e.at !== null) row.a = packTime(e.at);
    if (e.fa !== e.at) row.f = e.fa === null ? null : packTime(e.fa);
    if (e.run !== null) row.u = packId(e.run);
    if (e.th !== null) row.t = packTime(e.th);
    if (e.d != null) {
      row.d = packId(e.d);
      if (e.ds) row.s = 1;
    }
    if (e.x !== undefined) row.x = e.x;
    return row;
  });
  return { v: 1, reasons: s.reasons, rows };
}

export function decodeSnapshot(c: CompactSnapshot): WaitingSnapshot {
  const entries = c.rows.map((row): SnapshotEntry => {
    const at = row.a === undefined ? null : unpackTime(row.a);
    const entry: SnapshotEntry = {
      id: unpackId(row.i),
      at,
      r: row.r ?? -1,
      run: row.u === undefined ? null : unpackId(row.u),
      fa: row.f === undefined ? at : row.f === null ? null : unpackTime(row.f),
      th: row.t === undefined ? null : unpackTime(row.t),
    };
    if (row.d !== undefined) {
      entry.d = unpackId(row.d);
      entry.ds = row.s === 1;
    }
    if (row.x !== undefined) entry.x = row.x;
    return entry;
  });
  return { reasons: c.reasons, entries };
}

/** Accepts either form (tests and older callers pass the decoded snapshot). */
export function asWaitingSnapshot(s: WaitingSnapshot | CompactSnapshot | undefined): WaitingSnapshot | undefined {
  if (!s) return undefined;
  return "rows" in s ? decodeSnapshot(s) : s;
}
