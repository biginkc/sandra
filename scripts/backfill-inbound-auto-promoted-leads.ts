#!/usr/bin/env tsx
/**
 * One-off repair for properties auto-promoted by the inbound-SMS webhook.
 *
 * Dry run is the default and is read-only. Writes require --apply.
 *
 * The write path intentionally mirrors revertToProspect() in
 * src/app/(dashboard)/leads/actions.ts: status -> prospect, qualified_at null,
 * qualified_by null, updated_at stamped to the maintenance run timestamp.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { createAdminClient } from "../src/lib/supabase/admin";
import type { Json } from "../src/lib/supabase/types";

const PROD_PROJECT_REF = "copflsklaefwzipsrjqz";
const AUTO_PROMOTION_MARKERS = [
  "system:inbound_reply",
  "system:outbound_reply",
] as const;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_SAMPLE_SIZE = 10;
const UPDATED_AT_GRACE_MINUTES = 5;
const MANIFEST_DIR = "tmp/inbound-auto-promotion-backfill";

type Supabase = ReturnType<typeof createAdminClient>;
type AutoPromotionMarker = (typeof AUTO_PROMOTION_MARKERS)[number];

type Options = {
  apply: boolean;
  batchSize: number;
  sampleSize: number;
  useUpdatedAtCatchall: boolean;
  manifestPath: string | null;
  undoManifestPath: string | null;
};

type PropertyRow = {
  id: string;
  org_id: string;
  address: string | null;
  city: string | null;
  state: string | null;
  assigned_user_id: string | null;
  status: string;
  qualified_at: string | null;
  qualified_by: string | null;
  updated_at: string;
  outreach_dispo: string | null;
  follow_up_at: string | null;
  needs_human_attention: boolean | null;
  last_ai_escalation_at: string | null;
};

type NoteRow = {
  property_id: string;
  created_at: string;
};

type TaskRow = {
  related_property_id: string;
  created_at: string;
};

type MessageRow = {
  id: string;
  property_id: string | null;
  created_at: string;
  direction: string;
  metadata: Json | null;
  campaign_id: string | null;
};

type QueryResult<T> = {
  data: T[] | null;
  error: { message: string } | null;
};

type HumanTouchSignals = {
  blocking: string[];
  reportOnly: string[];
};

type Candidate = {
  property: PropertyRow;
  signals: HumanTouchSignals;
  eligible: boolean;
};

type ManifestRow = {
  id: string;
  org_id: string;
  address: string | null;
  city: string | null;
  state: string | null;
  assigned_user_id: string | null;
  status_before: string;
  qualified_at_before: string;
  qualified_by_before: string;
  updated_at_before: string;
};

type ApplyManifest = {
  script: "backfill-inbound-auto-promoted-leads";
  project_ref: string;
  generated_at: string;
  applied_at: string;
  completed_at: string | null;
  markers: AutoPromotionMarker[];
  strict_updated_at_catchall: boolean;
  planned_count: number;
  changed_ids: string[];
  rows: ManifestRow[];
};

function parseOptions(argv: string[]): Options {
  const options: Options = {
    apply: false,
    batchSize: DEFAULT_BATCH_SIZE,
    sampleSize: DEFAULT_SAMPLE_SIZE,
    useUpdatedAtCatchall: true,
    manifestPath: null,
    undoManifestPath: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--apply":
        options.apply = true;
        break;
      case "--ignore-updated-at-catchall":
        options.useUpdatedAtCatchall = false;
        break;
      case "--batch-size":
        options.batchSize = positiveIntArg(argv[++i], "--batch-size");
        break;
      case "--sample-size":
        options.sampleSize = positiveIntArg(argv[++i], "--sample-size");
        break;
      case "--manifest":
        options.manifestPath = requireValue(argv[++i], "--manifest");
        break;
      case "--undo":
        options.undoManifestPath = requireValue(argv[++i], "--undo");
        break;
      case "--help":
      case "-h":
        printUsage();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function positiveIntArg(value: string | undefined, name: string): number {
  const raw = requireValue(value, name);
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function requireValue(value: string | undefined, name: string): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function printUsage(): void {
  console.log(`
Usage:
  Dry run:
    npx tsx scripts/backfill-inbound-auto-promoted-leads.ts

  Apply after dry-run approval:
    npx tsx scripts/backfill-inbound-auto-promoted-leads.ts --apply

  Undo from an apply manifest:
    npx tsx scripts/backfill-inbound-auto-promoted-leads.ts --undo <manifest.json>
    npx tsx scripts/backfill-inbound-auto-promoted-leads.ts --undo <manifest.json> --apply

Options:
  --apply                         Execute writes. Default is read-only.
  --ignore-updated-at-catchall    Do not exclude rows whose only post-qualification signal is updated_at.
  --batch-size <n>                Update batch size. Default: ${DEFAULT_BATCH_SIZE}.
  --sample-size <n>               Rows to show in sample tables. Default: ${DEFAULT_SAMPLE_SIZE}.
  --manifest <path>               Apply manifest path. Default: ${MANIFEST_DIR}/backfill-<timestamp>.json.
`);
}

function projectRefFromEnv(): string {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL must be set.");
  }
  const hostname = new URL(url).hostname;
  return hostname.split(".")[0] ?? "";
}

function assertProdProject(projectRef: string): void {
  if (projectRef !== PROD_PROJECT_REF) {
    throw new Error(
      `Refusing to run: NEXT_PUBLIC_SUPABASE_URL points at ${projectRef}, expected prod ${PROD_PROJECT_REF}.`,
    );
  }
}

function asRecord(value: Json | null): Record<string, Json> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Json>)
    : {};
}

function isAiResponderMessage(message: MessageRow): boolean {
  return asRecord(message.metadata).generated_by === "ai_responder_v1";
}

function isAfter(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return new Date(left).getTime() > new Date(right).getTime();
}

function isSameInstant(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  return new Date(left).getTime() === new Date(right).getTime();
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function fullAddress(row: Pick<PropertyRow, "address" | "city" | "state">): string {
  return [row.address, row.city, row.state].filter(Boolean).join(", ");
}

function requiredQualifiedAt(property: PropertyRow): string {
  if (!property.qualified_at) {
    throw new Error(`Property ${property.id} matched the base query without qualified_at.`);
  }
  return property.qualified_at;
}

function requiredQualifiedBy(property: PropertyRow): string {
  if (!property.qualified_by) {
    throw new Error(`Property ${property.id} matched the base query without qualified_by.`);
  }
  return property.qualified_by;
}

async function pagedSelect<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<QueryResult<T>>,
  pageSize = 1_000,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const to = from + pageSize - 1;
    const { data, error } = await build(from, to);
    if (error) {
      throw new Error(`${label} query failed: ${error.message}`);
    }
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function loadQualifiedByCounts(
  supabase: Supabase,
): Promise<Map<string, number>> {
  const rows = await pagedSelect<{ qualified_by: string | null }>(
    "qualified_by distinct probe",
    (from, to) =>
      supabase
        .from("properties")
        .select("qualified_by")
        .not("qualified_by", "is", null)
        .order("qualified_by", { ascending: true })
        .range(from, to),
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    if (!row.qualified_by) continue;
    counts.set(row.qualified_by, (counts.get(row.qualified_by) ?? 0) + 1);
  }
  return counts;
}

function includedMarkersFromCounts(
  counts: Map<string, number>,
): AutoPromotionMarker[] {
  return AUTO_PROMOTION_MARKERS.filter((marker) => counts.has(marker));
}

async function loadBaseRows(
  supabase: Supabase,
  markers: AutoPromotionMarker[],
): Promise<PropertyRow[]> {
  if (markers.length === 0) return [];
  return pagedSelect<PropertyRow>(
    "base auto-promoted properties",
    (from, to) =>
      supabase
        .from("properties")
        .select(
          "id, org_id, address, city, state, assigned_user_id, status, qualified_at, qualified_by, updated_at, outreach_dispo, follow_up_at, needs_human_attention, last_ai_escalation_at",
        )
        .eq("status", "new_lead")
        .is("deleted_at", null)
        .not("qualified_at", "is", null)
        .in("qualified_by", markers)
        .order("qualified_at", { ascending: true })
        .range(from, to),
  );
}

async function loadRowsByProperty<T>(
  label: string,
  propertyIds: string[],
  runQuery: (ids: string[]) => PromiseLike<QueryResult<T>>,
): Promise<T[]> {
  const chunks = chunk(propertyIds, 500);
  const out: T[] = [];
  for (const ids of chunks) {
    const { data, error } = await runQuery(ids);
    if (error) throw new Error(`${label} query failed: ${error.message}`);
    out.push(...(data ?? []));
  }
  return out;
}

async function loadRelatedActivity(
  supabase: Supabase,
  rows: PropertyRow[],
): Promise<{
  notes: NoteRow[];
  tasks: TaskRow[];
  outboundMessages: MessageRow[];
  sequenceMessageIds: Set<string>;
}> {
  const propertyIds = rows.map((row) => row.id);
  if (propertyIds.length === 0) {
    return {
      notes: [],
      tasks: [],
      outboundMessages: [],
      sequenceMessageIds: new Set(),
    };
  }

  const minQualifiedAt = rows
    .map((row) => requiredQualifiedAt(row))
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0];

  const [notes, tasks, outboundMessages] = await Promise.all([
    loadRowsByProperty<NoteRow>("lead_notes", propertyIds, (ids) =>
      supabase
        .from("lead_notes")
        .select("property_id, created_at")
        .in("property_id", ids)
        .gt("created_at", minQualifiedAt),
    ),
    loadRowsByProperty<TaskRow>("tasks", propertyIds, (ids) =>
      supabase
        .from("tasks")
        .select("related_property_id, created_at")
        .in("related_property_id", ids)
        .gt("created_at", minQualifiedAt),
    ),
    loadRowsByProperty<MessageRow>("messages", propertyIds, (ids) =>
      supabase
        .from("messages")
        .select("id, property_id, created_at, direction, metadata, campaign_id")
        .in("property_id", ids)
        .eq("direction", "outbound")
        .gt("created_at", minQualifiedAt),
    ),
  ]);

  const outboundIds = outboundMessages.map((message) => message.id);
  const sequenceMessageIds = await loadSequenceMessageIds(supabase, outboundIds);
  return { notes, tasks, outboundMessages, sequenceMessageIds };
}

async function loadSequenceMessageIds(
  supabase: Supabase,
  messageIds: string[],
): Promise<Set<string>> {
  if (messageIds.length === 0) return new Set();
  const rows = await loadRowsByProperty<{ message_id: string | null }>(
    "sequence_step_runs",
    messageIds,
    (ids) =>
      supabase
        .from("sequence_step_runs")
        .select("message_id")
        .in("message_id", ids),
  );
  return new Set(
    rows
      .map((row) => row.message_id)
      .filter((id): id is string => typeof id === "string"),
  );
}

function indexByProperty<T>(
  rows: T[],
  propertyIdFor: (row: T) => string | null,
): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const propertyId = propertyIdFor(row);
    if (!propertyId) continue;
    const bucket = out.get(propertyId) ?? [];
    bucket.push(row);
    out.set(propertyId, bucket);
  }
  return out;
}

function buildCandidates(
  rows: PropertyRow[],
  activity: Awaited<ReturnType<typeof loadRelatedActivity>>,
  options: Options,
): Candidate[] {
  const notesByProperty = indexByProperty(activity.notes, (row) => row.property_id);
  const tasksByProperty = indexByProperty(activity.tasks, (row) => row.related_property_id);
  const messagesByProperty = indexByProperty(activity.outboundMessages, (row) => row.property_id);

  return rows.map((property) => {
    const signals = humanTouchSignals(property, {
      notes: notesByProperty.get(property.id) ?? [],
      tasks: tasksByProperty.get(property.id) ?? [],
      outboundMessages: messagesByProperty.get(property.id) ?? [],
      sequenceMessageIds: activity.sequenceMessageIds,
      useUpdatedAtCatchall: options.useUpdatedAtCatchall,
    });

    return {
      property,
      signals,
      eligible: signals.blocking.length === 0,
    };
  });
}

function humanTouchSignals(
  property: PropertyRow,
  params: {
    notes: NoteRow[];
    tasks: TaskRow[];
    outboundMessages: MessageRow[];
    sequenceMessageIds: Set<string>;
    useUpdatedAtCatchall: boolean;
  },
): HumanTouchSignals {
  const blocking: string[] = [];
  const reportOnly: string[] = [];
  const qualifiedAt = requiredQualifiedAt(property);

  if (property.outreach_dispo) {
    blocking.push(`outreach_dispo=${property.outreach_dispo}`);
  }
  if (property.follow_up_at) {
    blocking.push("follow_up_at_set");
  }

  const notesAfter = params.notes.filter((note) =>
    isAfter(note.created_at, qualifiedAt),
  ).length;
  if (notesAfter > 0) blocking.push(`lead_notes_after=${notesAfter}`);

  const tasksAfter = params.tasks.filter((task) =>
    isAfter(task.created_at, qualifiedAt),
  ).length;
  if (tasksAfter > 0) blocking.push(`tasks_after=${tasksAfter}`);

  const nonMachineOutbounds = params.outboundMessages.filter((message) => {
    if (!isAfter(message.created_at, qualifiedAt)) return false;
    if (isAiResponderMessage(message)) return false;
    if (params.sequenceMessageIds.has(message.id)) return false;
    return true;
  }).length;
  if (nonMachineOutbounds > 0) {
    blocking.push(`non_ai_non_sequence_outbound_after=${nonMachineOutbounds}`);
  }

  const updatedAtCutoff = addMinutes(qualifiedAt, UPDATED_AT_GRACE_MINUTES);
  if (isAfter(property.updated_at, updatedAtCutoff)) {
    const signal = `property_updated_after_qualified_at>${UPDATED_AT_GRACE_MINUTES}m`;
    if (params.useUpdatedAtCatchall) {
      blocking.push(signal);
    } else {
      reportOnly.push(signal);
    }
  }

  if (property.needs_human_attention && property.last_ai_escalation_at) {
    reportOnly.push("ai_attention_flag_present");
  }

  return { blocking, reportOnly };
}

function summarizeBuckets(candidates: Candidate[]): Map<string, number> {
  const buckets = new Map<string, number>();
  for (const candidate of candidates) {
    const key =
      candidate.signals.blocking.length === 0
        ? "eligible_no_blocking_signals"
        : candidate.signals.blocking.sort().join(" + ");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  return buckets;
}

function tableRow(candidate: Candidate): Record<string, string | null> {
  const blocking = candidate.signals.blocking.join("; ");
  const reportOnly = candidate.signals.reportOnly.join("; ");
  return {
    id: candidate.property.id,
    address: fullAddress(candidate.property),
    org: candidate.property.org_id,
    assigned_user: candidate.property.assigned_user_id,
    qualified_at: candidate.property.qualified_at,
    qualified_by: candidate.property.qualified_by,
    status: candidate.property.status,
    signal:
      blocking ||
      (reportOnly ? `include; report_only=${reportOnly}` : "include; no_human_touch_signals"),
  };
}

function printReport(params: {
  projectRef: string;
  qualifiedByCounts: Map<string, number>;
  includedMarkers: AutoPromotionMarker[];
  baseRows: PropertyRow[];
  candidates: Candidate[];
  options: Options;
}): void {
  const eligible = params.candidates.filter((candidate) => candidate.eligible);
  const excluded = params.candidates.filter((candidate) => !candidate.eligible);
  const coreOnlyEligible = params.candidates.filter(
    (candidate) =>
      candidate.signals.blocking.filter(
        (signal) =>
          !signal.startsWith("property_updated_after_qualified_at>"),
      ).length === 0,
  ).length;

  console.log("");
  console.log("=== DRY RUN - inbound auto-promotion backfill ===");
  console.log(`Supabase project: ${params.projectRef}`);
  console.log(`Write mode: ${params.options.apply ? "APPLY REQUESTED" : "dry-run only"}`);
  console.log("");
  console.log("Distinct qualified_by values in prod");
  console.table(
    [...params.qualifiedByCounts.entries()].map(([qualifiedBy, count]) => ({
      qualified_by: qualifiedBy,
      count,
    })),
  );
  console.log(`Auto-promotion markers included: ${params.includedMarkers.join(", ") || "(none)"}`);
  console.log("");
  console.log(`Base rows: ${params.baseRows.length}`);
  console.log("  Criteria: status='new_lead', deleted_at IS NULL, qualified_at IS NOT NULL, qualified_by in included system markers.");
  console.log(`Eligible rows in current mode: ${eligible.length}`);
  console.log(`Excluded rows in current mode: ${excluded.length}`);
  console.log(
    `Eligible if the updated_at catch-all is ignored: ${coreOnlyEligible}`,
  );
  console.log(
    `updated_at catch-all: ${
      params.options.useUpdatedAtCatchall ? "enabled" : "report-only"
    }`,
  );
  console.log("");
  console.log("Signal buckets");
  console.table(
    [...summarizeBuckets(params.candidates).entries()].map(([signal, count]) => ({
      signal,
      count,
    })),
  );

  console.log("");
  console.log(`Eligible sample (${Math.min(params.options.sampleSize, eligible.length)} of ${eligible.length})`);
  console.table(eligible.slice(0, params.options.sampleSize).map(tableRow));

  console.log("");
  console.log(`Excluded sample (${Math.min(params.options.sampleSize, excluded.length)} of ${excluded.length})`);
  console.table(excluded.slice(0, params.options.sampleSize).map(tableRow));
  console.log("");
}

function manifestRows(candidates: Candidate[]): ManifestRow[] {
  return candidates
    .filter((candidate) => candidate.eligible)
    .map(({ property }) => ({
      id: property.id,
      org_id: property.org_id,
      address: property.address,
      city: property.city,
      state: property.state,
      assigned_user_id: property.assigned_user_id,
      status_before: property.status,
      qualified_at_before: requiredQualifiedAt(property),
      qualified_by_before: requiredQualifiedBy(property),
      updated_at_before: property.updated_at,
    }));
}

function defaultManifestPath(now: string): string {
  return resolve(
    MANIFEST_DIR,
    `backfill-${now.replaceAll(":", "-").replaceAll(".", "-")}.json`,
  );
}

function writeManifest(path: string, manifest: ApplyManifest): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function applyBackfill(params: {
  supabase: Supabase;
  projectRef: string;
  candidates: Candidate[];
  includedMarkers: AutoPromotionMarker[];
  options: Options;
}): Promise<void> {
  const rows = manifestRows(params.candidates);
  if (rows.length === 0) {
    console.log("No eligible rows to update.");
    return;
  }

  const appliedAt = new Date().toISOString();
  const manifest: ApplyManifest = {
    script: "backfill-inbound-auto-promoted-leads",
    project_ref: params.projectRef,
    generated_at: new Date().toISOString(),
    applied_at: appliedAt,
    completed_at: null,
    markers: params.includedMarkers,
    strict_updated_at_catchall: params.options.useUpdatedAtCatchall,
    planned_count: rows.length,
    changed_ids: [],
    rows,
  };
  const manifestPath = resolve(
    params.options.manifestPath ?? defaultManifestPath(appliedAt),
  );
  writeManifest(manifestPath, manifest);
  console.log(`Apply manifest written before updates: ${manifestPath}`);

  const rowsByOrg = new Map<string, ManifestRow[]>();
  for (const row of rows) {
    const bucket = rowsByOrg.get(row.org_id) ?? [];
    bucket.push(row);
    rowsByOrg.set(row.org_id, bucket);
  }

  const changedIds: string[] = [];
  for (const [orgId, orgRows] of rowsByOrg.entries()) {
    for (const batch of chunk(orgRows, params.options.batchSize)) {
      const ids = batch.map((row) => row.id);
      const { data: updatedRows, error, count } = await params.supabase
        .from("properties")
        .update(
          {
            status: "prospect",
            qualified_at: null,
            qualified_by: null,
            updated_at: appliedAt,
          },
          { count: "exact" },
        )
        .eq("org_id", orgId)
        .eq("status", "new_lead")
        .in("qualified_by", params.includedMarkers)
        .not("qualified_at", "is", null)
        .is("deleted_at", null)
        .in("id", ids)
        .select("id");

      if (error) {
        throw new Error(`Backfill update failed for org ${orgId}: ${error.message}`);
      }
      const updatedIds = (updatedRows ?? []).map((row) => row.id);
      console.log(`Updated org=${orgId} batch=${ids.length} count=${count ?? updatedIds.length}`);
      changedIds.push(...updatedIds);
    }
  }

  manifest.changed_ids = changedIds;
  manifest.completed_at = new Date().toISOString();
  writeManifest(manifestPath, manifest);
  console.log("");
  console.log(`Changed rows: ${changedIds.length}`);
  console.log("Changed ids");
  for (const id of changedIds) console.log(`  ${id}`);
  console.log(`Undo manifest: ${manifestPath}`);
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function readManifest(path: string): ApplyManifest {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ApplyManifest;
  if (parsed.script !== "backfill-inbound-auto-promoted-leads") {
    throw new Error(`Manifest ${path} was not created by this script.`);
  }
  if (!Array.isArray(parsed.rows)) {
    throw new Error(`Manifest ${path} is missing rows.`);
  }
  return parsed;
}

async function runUndo(params: {
  supabase: Supabase;
  projectRef: string;
  options: Options;
}): Promise<void> {
  if (!params.options.undoManifestPath) {
    throw new Error("undoManifestPath is required.");
  }
  const manifestPath = resolve(params.options.undoManifestPath);
  const manifest = readManifest(manifestPath);
  if (manifest.project_ref !== params.projectRef) {
    throw new Error(
      `Manifest project_ref=${manifest.project_ref} does not match connected project ${params.projectRef}.`,
    );
  }

  const ids = manifest.rows.map((row) => row.id);
  const currentRows = await pagedSelect<{
    id: string;
    status: string;
    qualified_at: string | null;
    qualified_by: string | null;
    updated_at: string | null;
  }>("undo current properties", (from, to) =>
    params.supabase
      .from("properties")
      .select("id, status, qualified_at, qualified_by, updated_at")
      .in("id", ids)
      .range(from, to),
  );
  const currentById = new Map(currentRows.map((row) => [row.id, row]));
  const undoable = manifest.rows.filter((row) => {
    const current = currentById.get(row.id);
    if (!current) return false;
    const stillBackfilled =
      current.status === "prospect" &&
      current.qualified_at === null &&
      current.qualified_by === null &&
      isSameInstant(current.updated_at, manifest.applied_at);
    return stillBackfilled;
  });
  const skipped = manifest.rows.length - undoable.length;

  console.log("");
  console.log("=== UNDO - inbound auto-promotion backfill ===");
  console.log(`Manifest: ${manifestPath}`);
  console.log(`Rows in manifest: ${manifest.rows.length}`);
  console.log(`Undoable rows: ${undoable.length}`);
  console.log(`Skipped rows: ${skipped}`);
  console.log(`Write mode: ${params.options.apply ? "APPLY REQUESTED" : "dry-run only"}`);
  console.log("");

  if (!params.options.apply) {
    console.log("DRY RUN COMPLETE. No rows changed. Re-run with --undo <manifest> --apply after approval.");
    return;
  }

  const changedIds: string[] = [];
  for (const row of undoable) {
    const { error } = await params.supabase
      .from("properties")
      .update({
        status: row.status_before,
        qualified_at: row.qualified_at_before,
        qualified_by: row.qualified_by_before,
        updated_at: row.updated_at_before,
      })
      .eq("id", row.id)
      .eq("org_id", row.org_id)
      .eq("status", "prospect")
      .is("qualified_at", null)
      .is("qualified_by", null)
      .eq("updated_at", manifest.applied_at);

    if (error) {
      throw new Error(`Undo failed for ${row.id}: ${error.message}`);
    }
    changedIds.push(row.id);
  }

  console.log(`Undo changed rows: ${changedIds.length}`);
  console.log("Undo changed ids");
  for (const id of changedIds) console.log(`  ${id}`);
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const projectRef = projectRefFromEnv();
  assertProdProject(projectRef);
  const supabase = createAdminClient();

  if (options.undoManifestPath) {
    await runUndo({ supabase, projectRef, options });
    return;
  }

  const qualifiedByCounts = await loadQualifiedByCounts(supabase);
  const includedMarkers = includedMarkersFromCounts(qualifiedByCounts);
  const baseRows = await loadBaseRows(supabase, includedMarkers);
  const activity = await loadRelatedActivity(supabase, baseRows);
  const candidates = buildCandidates(baseRows, activity, options);

  printReport({
    projectRef,
    qualifiedByCounts,
    includedMarkers,
    baseRows,
    candidates,
    options,
  });

  if (!options.apply) {
    console.log("DRY RUN COMPLETE. No rows changed.");
    console.log("After approval, apply with:");
    console.log("  npx tsx scripts/backfill-inbound-auto-promoted-leads.ts --apply");
    return;
  }

  await applyBackfill({
    supabase,
    projectRef,
    candidates,
    includedMarkers,
    options,
  });
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
