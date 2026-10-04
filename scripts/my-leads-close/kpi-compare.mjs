#!/usr/bin/env node
// Compares two KPI snapshots under the parity rules (TECH-PLAN Phase 4, item 4.6).
//
//   node scripts/my-leads-close/kpi-compare.mjs before.json after.json \
//     [--closeout-count <n>] [--closeout-by-window <json: {"<window label>": n}>] [--run-id <uuid>]
//
// Exit 1 on any violation or a missing row. Current-state tiles are never compared to "before"; the
// independent recount for `contactWithoutFollowUp` is a SQL step in the runbook (plan 4.6) and is
// passed in as `--expected-contact-drop <n>` when available.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { CURRENT_STATE_MAY_CHANGE, EQUAL_IN_CLOSED_WINDOWS, EQUAL_UNLESS_CLOSEOUT, FLOAT_TOLERANCE, RULES } from "./kpi-rules.mjs";

const rowKey = (row) => `${row.member}|${row.window}`;

function equal(key, before, after) {
  const tolerance = FLOAT_TOLERANCE[key];
  if (tolerance !== undefined && typeof before === "number" && typeof after === "number") return Math.abs(before - after) < tolerance;
  return JSON.stringify(before) === JSON.stringify(after);
}

/**
 * Pure comparison. `options.closeoutByWindow` maps a window label to the number of closed-out
 * attempts whose `occurred_at` falls inside it (computed independently from the Phase 1e before-images).
 * Returns `{ ok, violations, compared }`.
 */
export function compare(before, after, options = {}) {
  const closeoutByWindow = options.closeoutByWindow ?? {};
  const violations = [];
  let compared = 0;
  const afterRows = new Map(after.rows.map((row) => [rowKey(row), row]));
  for (const b of before.rows) {
    const a = afterRows.get(rowKey(b));
    if (!a) {
      violations.push({ member: b.member, window: b.window, key: "*", reason: "missing after row" });
      continue;
    }
    if (b.kpi?.error !== undefined || a.kpi?.error !== undefined) {
      // A rejected member is compared as equal-to-itself, never skipped silently.
      compared += 1;
      if (b.kpi?.error !== a.kpi?.error) violations.push({ member: b.member, window: b.window, key: "error", reason: `before=${b.kpi?.error} after=${a.kpi?.error}` });
      continue;
    }
    const keys = new Set([...Object.keys(b.kpi), ...Object.keys(a.kpi)]);
    for (const key of keys) {
      const rule = RULES[key];
      if (!rule) {
        violations.push({ member: b.member, window: b.window, key, reason: "unclassified key (add it to kpi-rules.mjs)" });
        continue;
      }
      if (rule === CURRENT_STATE_MAY_CHANGE) continue;
      compared += 1;
      if (rule === EQUAL_IN_CLOSED_WINDOWS) {
        if (!equal(key, b.kpi[key], a.kpi[key])) violations.push({ member: b.member, window: b.window, key, reason: `before=${JSON.stringify(b.kpi[key])} after=${JSON.stringify(a.kpi[key])}` });
      } else if (rule === EQUAL_UNLESS_CLOSEOUT) {
        const closed = Number(closeoutByWindow[b.window] ?? 0);
        const ok = a.kpi[key] === b.kpi[key] || a.kpi[key] === b.kpi[key] - closed;
        if (!ok) violations.push({ member: b.member, window: b.window, key, reason: `before=${b.kpi[key]} after=${a.kpi[key]} closeout=${closed}` });
      }
    }
  }
  for (const a of after.rows) {
    if (!before.rows.some((b) => rowKey(b) === rowKey(a))) violations.push({ member: a.member, window: a.window, key: "*", reason: "missing before row" });
  }
  return { ok: violations.length === 0, violations, compared };
}

export function formatTable(result) {
  const lines = [`compared ${result.compared} values, ${result.violations.length} violation(s)`];
  for (const v of result.violations) lines.push(`  ${v.member}  ${v.window}  ${v.key}  ${v.reason}`);
  return `${lines.join("\n")}\n`;
}

export function parseArgs(argv) {
  const [beforePath, afterPath, ...rest] = argv;
  if (!beforePath || !afterPath) throw new Error("usage: kpi-compare.mjs before.json after.json [--closeout-by-window <json>] [--run-id <uuid>]");
  const options = { closeoutByWindow: {}, runId: null };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    i += 1;
    if (flag === "--closeout-by-window") options.closeoutByWindow = JSON.parse(value);
    else if (flag === "--closeout-count") options.closeoutByWindow["since-launch"] = Number(value);
    else if (flag === "--run-id") options.runId = value;
    else throw new Error(`Unknown argument ${flag}`);
  }
  return { beforePath, afterPath, options };
}

export function main(argv, io = { out: (t) => process.stdout.write(t) }) {
  const { beforePath, afterPath, options } = parseArgs(argv);
  const before = JSON.parse(readFileSync(beforePath, "utf8"));
  const after = JSON.parse(readFileSync(afterPath, "utf8"));
  const result = compare(before, after, options);
  io.out(formatTable(result));
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  }
}
