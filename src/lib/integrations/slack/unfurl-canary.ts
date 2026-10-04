import { createAdminClient } from "@/lib/supabase/admin";

import type { SlackUnfurlJob } from "./unfurl-store";
import { loadPreviewData } from "./unfurl-data";
import type { SlackLeadPreviewSnapshot } from "./unfurl-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_HISTORY_ROWS = 3;

export type SlackCanaryPreviewSnapshot = SlackLeadPreviewSnapshot;

type QueryResult = {
  data: unknown;
  error: { message?: string } | null;
};

type QueryBuilder = PromiseLike<QueryResult> & {
  select(columns: string): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  is(column: string, value: null): QueryBuilder;
  or(filters: string): QueryBuilder;
  limit(count: number): QueryBuilder;
};

type CanaryClient = {
  from(table: string): QueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<QueryResult>;
};

type PropertyRow = {
  id: string;
  org_id: string;
  homeowner_contact_id: string | null;
  notes: string | null;
  deleted_at?: string | null;
};

type ContactRow = {
  id: string;
  org_id: string;
  first_name: string | null;
  last_name: string | null;
  entity_name: string | null;
  notes: string | null;
  phone_1: string | null;
  phone_2: string | null;
  phone_3: string | null;
};

type HistoryRow = {
  id: string;
  property_id: string | null;
  contact_id: string | null;
  metadata: unknown;
};

type AttemptFacts = {
  latest_attempt_id: string | null;
};

/** The marker format used by run-owned Slack acceptance fixtures. */
export function slackCanaryRunMarker(runId: string): string {
  return `SLACK PREVIEW CANARY ${runId}`;
}

/** Load the server-authoritative render snapshot used by the internal fence. */
export async function loadSlackCanaryPreview(input: {
  job: SlackUnfurlJob;
  propertyId: string;
}): Promise<SlackCanaryPreviewSnapshot | null> {
  if (typeof input.job.org_id !== "string") return null;
  return loadPreviewData({
    client: createAdminClient(),
    orgId: input.job.org_id,
    propertyId: input.propertyId,
  });
}

/** Deep-freeze the server-captured snapshot before passing it to the worker. */
export function freezeSlackCanaryPreview(snapshot: SlackCanaryPreviewSnapshot): SlackCanaryPreviewSnapshot {
  const messages = snapshot.messages.map((message) => Object.freeze({ ...message }));
  const latestAttempt = snapshot.latestAttempt ? Object.freeze({ ...snapshot.latestAttempt }) : null;
  return Object.freeze({ ...snapshot, latestAttempt, messages: Object.freeze(messages) });
}

function propertyRunMarker(runId: string): string {
  return `${slackCanaryRunMarker(runId)}; synthetic only; no seller contact`;
}

function contactRunMarker(runId: string): string {
  return `${slackCanaryRunMarker(runId)}; synthetic only; no phone; no outreach`;
}

async function read(query: PromiseLike<QueryResult>): Promise<unknown> {
  const result = await query;
  if (result.error) throw new Error("slack_canary_fixture_read_failed");
  return result.data;
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function nonEmpty(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isHistoryRow(value: unknown, runId: string): value is HistoryRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const metadata = row.metadata;
  return typeof row.id === "string" &&
    (row.property_id === null || typeof row.property_id === "string") &&
    (row.contact_id === null || typeof row.contact_id === "string") &&
    !!metadata && typeof metadata === "object" && !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).canaryRunId === runId;
}

async function noProviderIntentRows(
  db: CanaryClient,
  orgId: string,
  propertyId: string,
  contactId: string,
  runId: string,
): Promise<boolean> {
  // The service-only boolean RPC owns the ledger read. The route receives no
  // table rows or provider metadata, and an unavailable/erroring RPC fails
  // closed.
  try {
    return (await read(db.rpc("get_slack_canary_provider_safety", {
      p_org_id: orgId,
      p_property_id: propertyId,
      p_contact_id: contactId,
      p_run_id: runId,
    }))) === true;
  } catch {
    return false;
  }
}

/**
 * Prove that the target is the current run-owned synthetic fixture before the
 * unchanged Slack worker is allowed to read or send anything. Notes are
 * user-editable, so the exact run-owned history metadata, persisted claim and
 * scoped attempt fact remain required backstops. This function is intentionally
 * read-only and returns no fixture data to the HTTP route.
 */
export async function verifySlackCanaryFixture(input: {
  job: SlackUnfurlJob;
  runId: string;
  propertyId: string;
}): Promise<boolean> {
  if (!isUuid(input.runId) || !isUuid(input.propertyId) || !isUuid(input.job.org_id)) return false;
  const db = createAdminClient() as unknown as CanaryClient;
  const orgId = input.job.org_id;

  const property = (await read(
    db.from("properties")
      .select("id,org_id,homeowner_contact_id,notes,deleted_at")
      .eq("id", input.propertyId)
      .eq("org_id", orgId)
      .is("deleted_at", null)
      .limit(1),
  )) as PropertyRow[] | null;
  const row = Array.isArray(property) ? property[0] : null;
  if (!row || row.id !== input.propertyId || row.org_id !== orgId || !isUuid(row.homeowner_contact_id)) return false;
  if (row.notes?.trim() !== propertyRunMarker(input.runId)) return false;

  const contactRows = (await read(
    db.from("contacts")
      .select("id,org_id,first_name,last_name,entity_name,notes,phone_1,phone_2,phone_3")
      .eq("id", row.homeowner_contact_id)
      .eq("org_id", orgId)
      .limit(1),
  )) as ContactRow[] | null;
  const contact = Array.isArray(contactRows) ? contactRows[0] : null;
  if (!contact || contact.id !== row.homeowner_contact_id || contact.org_id !== orgId) return false;
  if (contact.notes?.trim() !== contactRunMarker(input.runId)) return false;
  if ([contact.phone_1, contact.phone_2, contact.phone_3].some((value) => nonEmpty(value) !== null)) return false;

  const history = (await read(
    db.from("messages")
      .select("id,property_id,contact_id,metadata")
      .eq("org_id", orgId)
      .eq("channel", "sms")
      .or(`property_id.eq.${input.propertyId},and(property_id.is.null,contact_id.eq.${row.homeowner_contact_id})`)
      .limit(MAX_HISTORY_ROWS + 1),
  )) as unknown;
  if (!Array.isArray(history) || history.length !== MAX_HISTORY_ROWS || !history.every((message) => isHistoryRow(message, input.runId))) return false;
  if (!history.every((message) =>
    (message.property_id === input.propertyId && (message.contact_id === null || message.contact_id === row.homeowner_contact_id)) ||
    (message.property_id === null && message.contact_id === row.homeowner_contact_id))) return false;

  const attemptFacts = (await read(
    db.rpc("get_slack_preview_attempt_facts", { p_org_id: orgId, p_property_id: input.propertyId }),
  )) as AttemptFacts[] | null;
  const attempt = Array.isArray(attemptFacts) ? attemptFacts[0] : null;
  if (
    !attempt ||
    typeof attempt.latest_attempt_id !== "string"
  ) return false;

  return noProviderIntentRows(db, orgId, input.propertyId, row.homeowner_contact_id, input.runId);
}
