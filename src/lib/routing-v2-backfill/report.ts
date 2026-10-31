/**
 * Routing v2 backfill report: one markdown summary + CSVs per run. Line 1 of every file is the
 * git SHA the script ran at. No phone numbers, no message text, no secrets: ids and counts only.
 */
import { AGE_BUCKETS, SKIP_REASONS, type AgeBucket } from "./select";
import { treatmentFor, type BackfillRunResult, type ItemResult, type Treatment } from "./run";

/** Jev price per call is not reported by the provider; the report shows counts, plus Haiku dollars. */
function countBy<T>(items: readonly T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) m.set(key(it), (m.get(key(it)) ?? 0) + 1);
  return m;
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(sha: string, header: string[], rows: unknown[][]): string {
  return [`# sha ${sha}`, header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
}

export function candidatesCsv(sha: string, r: BackfillRunResult): string {
  return toCsv(sha, ["property_id", "inbound_message_id", "last_inbound_age_days", "age_bucket", "treatment", "superseded_older_texts", "in_this_run"],
    r.selection.candidates
      .slice().sort((a, b) => a.ageDays - b.ageDays)
      .map((c) => [c.propertyId, c.id, c.ageDays.toFixed(1), c.bucket, treatmentFor(c.ageDays, r.options.textMaxAgeDays), c.supersedes.length, r.dispatched.some((d) => d.id === c.id) ? "yes" : "no"]));
}

export function skippedCsv(sha: string, r: BackfillRunResult): string {
  return toCsv(sha, ["property_id", "inbound_message_id", "age_days", "age_bucket", "reason"],
    [
      ...r.selection.skipped.map((s) => [s.propertyId, s.inboundId, s.ageDays.toFixed(1), s.bucket, s.reason]),
      ...r.selection.superseded.map((s) => [s.propertyId, s.inboundId, s.ageDays.toFixed(1), s.bucket, `backfill_superseded_by:${s.byInboundId}`]),
    ]);
}

const ITEM_COLUMNS: Array<keyof ItemResult> = [
  "inboundId", "propertyId", "ageDays", "bucket", "mode", "treatment", "road", "decisionStatus", "outcome", "jevCalls", "haikuCalls", "haikuUsd",
  "repliesQueued", "repliesSent", "alertsQueued", "dripsStarted", "holdCreated", "holdReason", "suppressionCreated",
  "wouldReply", "wouldDrip", "wouldAlert", "wouldHold", "wouldClose", "error",
];

export function itemsCsv(sha: string, r: BackfillRunResult): string {
  return toCsv(sha, ITEM_COLUMNS as string[], r.items.map((it) => ITEM_COLUMNS.map((k) => it[k])));
}

function table(header: string[], rows: Array<Array<string | number>>): string {
  return [`| ${header.join(" | ")} |`, `| ${header.map(() => "---").join(" | ")} |`, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

export function markdownReport(sha: string, r: BackfillRunResult): string {
  const sel = r.selection;
  const items = r.items;
  const lines: string[] = [];
  lines.push(`SHA: ${sha}`);
  lines.push("");
  lines.push(`# Routing v2 backfill: ${r.mode} run ${r.runId}`);
  lines.push("");
  lines.push(`- Org: ${r.orgId}`);
  lines.push(`- Started ${r.startedAt}, finished ${r.finishedAt}`);
  lines.push(`- Window: last ${r.options.maxAgeDays} days; full treatment up to ${r.options.textMaxAgeDays} days; batch max age: ${r.options.batchMaxAgeDays ?? "none"}; limit: ${r.options.limit ?? "none"}; rate: ${r.options.ratePerMinute}/min`);
  lines.push(`- Flags: ${Object.entries(r.flags).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  for (const w of r.flagWarnings) lines.push(`- WARNING: ${w}`);
  lines.push("");

  lines.push("## Candidates (newest unanswered seller text per property)");
  lines.push("");
  const byBucket = countBy(sel.candidates, (c) => c.bucket);
  const dispatchedByBucket = countBy(r.dispatched, (c) => c.bucket);
  const supersededByBucket = countBy(sel.superseded, (s) => s.bucket);
  lines.push(`Full treatment: <= ${r.options.textMaxAgeDays} days old (${sel.candidates.filter((c) => treatmentFor(c.ageDays, r.options.textMaxAgeDays) === "full").length} candidates). Sort only: older (${sel.candidates.filter((c) => treatmentFor(c.ageDays, r.options.textMaxAgeDays) === "sort_only").length} candidates).`);
  lines.push("");
  lines.push(table(["Age", "Candidates", "In this run", "Older texts superseded"],
    AGE_BUCKETS.filter((b) => b !== "61d+").map((b: AgeBucket): Array<string | number> => [b, byBucket.get(b) ?? 0, dispatchedByBucket.get(b) ?? 0, supersededByBucket.get(b) ?? 0])
      .concat([["Total", sel.candidates.length, r.dispatched.length, sel.superseded.length]])));
  lines.push("");

  lines.push("## Skipped (property's newest text), by reason");
  lines.push("");
  const skipCounts = countBy(sel.skipped.filter((s) => s.reason !== "outside_window"), (s) => s.reason);
  lines.push(table(["Reason", ...AGE_BUCKETS.filter((b) => b !== "61d+"), "Total"],
    SKIP_REASONS.filter((reason) => (skipCounts.get(reason) ?? 0) > 0).map((reason) => [
      reason,
      ...AGE_BUCKETS.filter((b) => b !== "61d+").map((b) => sel.skipped.filter((s) => s.reason === reason && s.bucket === b).length),
      skipCounts.get(reason) ?? 0,
    ])));
  lines.push("");

  if (r.mode !== "dry_run") {
    const groups: Array<[Treatment, string]> = [
      ["full", `Full treatment (replies <= ${r.options.textMaxAgeDays} days old): reply + drip + alert + hold + suppression`],
      ["sort_only", `Sort only (replies ${r.options.textMaxAgeDays + 1}-${r.options.maxAgeDays} days old): stops, holds, closes, hot alerts; NO reply, NO drip`],
    ];
    for (const [treatment, title] of groups) {
      const its = items.filter((i) => i.treatment === treatment);
      lines.push(`## ${title}`);
      lines.push("");
      lines.push(r.mode === "classify_only" ? "Decided only; nothing was carried out. Columns show what --apply would do." : "Carried out.");
      lines.push("");
      if (its.length === 0) {
        lines.push("None in this run.");
        lines.push("");
        continue;
      }
      const roads = [...countBy(its, (i) => i.road).entries()].sort((a, b) => b[1] - a[1]);
      const buckets = AGE_BUCKETS.filter((b) => b !== "61d+" && its.some((i) => i.bucket === b));
      lines.push(table(["Road", ...buckets, "Total",
        ...(r.mode === "classify_only" ? ["Would reply", "Would drip", "Would alert", "Would hold", "Would close"] : ["Replies sent", "Drips started", "Alerts queued", "Holds", "Suppressions"])],
        roads.map(([road, n]) => {
          const rs = its.filter((i) => i.road === road);
          const sum = (f: (i: ItemResult) => number | boolean) => rs.reduce((acc, i) => acc + Number(f(i)), 0);
          return [road, ...buckets.map((b) => rs.filter((i) => i.bucket === b).length), n,
            ...(r.mode === "classify_only"
              ? [sum((i) => i.wouldReply), sum((i) => i.wouldDrip), sum((i) => i.wouldAlert), sum((i) => i.wouldHold), sum((i) => i.wouldClose)]
              : [sum((i) => i.repliesSent), sum((i) => i.dripsStarted), sum((i) => i.alertsQueued), sum((i) => i.holdCreated), sum((i) => i.suppressionCreated)])];
        })));
      lines.push("");
      const tot = (f: (i: ItemResult) => number | boolean) => its.reduce((acc, i) => acc + Number(f(i)), 0);
      const holdReasons = countBy(its.filter((i) => i.holdCreated), (i) => i.holdReason ?? "unknown");
      lines.push(table(["Measure", "Count"], [
        ["Texts dispatched", its.length],
        ["Errors (nothing done; see items CSV)", its.filter((i) => i.error).length],
        ["Jev calls", tot((i) => i.jevCalls)],
        ["Haiku calls", tot((i) => i.haikuCalls)],
        ["Haiku cost (USD)", tot((i) => i.haikuUsd).toFixed(4)],
        ["Sends queued (outbox replies)", tot((i) => i.repliesQueued)],
        ["Sends delivered by this run", tot((i) => i.repliesSent)],
        ["Drips started", tot((i) => i.dripsStarted)],
        ["Alerts queued (outbox alerts)", tot((i) => i.alertsQueued)],
        ["Holds created (each raises today's hold alert)", tot((i) => i.holdCreated)],
        ["Suppressions created", tot((i) => i.suppressionCreated)],
      ]));
      if (holdReasons.size > 0) {
        lines.push("");
        lines.push("Hold reasons: " + [...holdReasons.entries()].map(([k, v]) => `${k} ${v}`).join(", "));
      }
      lines.push("");
    }
    lines.push(`Older texts marked backfill_superseded this run: ${r.supersededMarked}`);
    lines.push("");
  }
  lines.push("Files: candidates.csv (property id + last inbound age), skipped.csv, items.csv (one row per dispatched text). No phone numbers or message text are written.");
  return lines.join("\n") + "\n";
}
