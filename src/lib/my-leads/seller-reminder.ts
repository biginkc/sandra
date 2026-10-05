import { randomUUID } from "node:crypto";

import { openingIdentityError } from "@/lib/messaging/opening-identity";
import { evaluateSuppression } from "@/lib/messaging/suppression";
import { getQuietHoursLocalTime, STATE_TO_TZ } from "@/lib/messaging/quiet-hours";
import { wallTimeToUtc } from "@/lib/time/zoned";
import type { ConsentState } from "@/lib/messaging/consent";
import type { SendSmsInput, SendSmsOutcome } from "@/lib/messaging/send";

import { SELLER_REMINDER_COPY } from "./seller-reminder-copy";

/**
 * Seller morning-of reminder job (D9, second half). The text body is the exact copy Jarrad approved in
 * `seller-reminder-copy.ts`; this module only substitutes `{first_name}` and `{time}`.
 *
 * Nothing sends unless ALL of: the `seller_reminders` flag is on for the org, the org's
 * `seller_reminder_settings.enabled` is true, and the copy constant is non-null. Both switches are
 * re-read immediately before every dispatch, so a row claimed before an operator disabled the job
 * never sends.
 */

export const REMINDER_MAX_ATTEMPTS = 3;
export const RETRY_STEP_MS = 5 * 60_000;
/** A deferral must still leave at least this long before the call. */
export const MIN_LEAD_BEFORE_CALL_MS = 15 * 60_000;
export const SELLER_REMINDER_BODY_MAX = 320;
const BODY_TOKENS = new Set(["first_name", "time"]);
const CLOSED_PROPERTY_STATUSES = new Set(["closed", "dead", "dnc"]);

// ---------------------------------------------------------------- body

export function buildSellerReminderBody(
  copy: string,
  vars: { firstName: string | null; localTime: string },
): string {
  const body = copy.replace(/\{([^{}]*)\}/g, (_match, name: string) => {
    if (!BODY_TOKENS.has(name)) throw new Error(`Unknown seller reminder token {${name}}`);
    if (name === "first_name") {
      const first = vars.firstName?.trim();
      if (!first) throw new Error("Seller reminder needs a first name");
      return first;
    }
    return vars.localTime;
  });
  if (body.length > SELLER_REMINDER_BODY_MAX) {
    throw new Error(`Seller reminder body exceeds ${SELLER_REMINDER_BODY_MAX} characters`);
  }
  return body;
}

export function copyNeedsFirstName(copy: string): boolean {
  return /\{first_name\}/.test(copy);
}

/** The appointment time in the seller's own zone, e.g. "2:30 PM". */
export function formatReminderLocalTime(dueAt: Date, state: string | null): string | null {
  const zone = state ? STATE_TO_TZ[state.trim().toUpperCase()] : undefined;
  if (!zone) return null;
  return new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" })
    .format(dueAt)
    .replace(/\s/g, " ");
}

// ---------------------------------------------------------------- quiet-hours deferral

/** The next 08:00 in the recipient's zone (today's when it is before 08:00, tomorrow's from 21:00). */
export function nextQuietHoursOpen(state: string | null, now: Date): Date | null {
  const local = getQuietHoursLocalTime(state, now);
  if (!local) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: local.zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const date = new Date(Date.UTC(get("year"), get("month") - 1, get("day") + (local.hour >= 8 ? 1 : 0)));
  const iso = date.toISOString().slice(0, 10);
  const open = wallTimeToUtc({ date: iso, time: "08:00", timeZone: local.zone });
  return open.ok ? open.utc : null;
}

// ---------------------------------------------------------------- decision (pure)

export type ReminderDecision =
  | { action: "send"; localTime: string }
  | { action: "skip"; reason: string }
  | { action: "cancel"; reason: string }
  | { action: "defer"; reason: string; retryAt: Date };

export type DecideReminderInputs = {
  now: Date;
  claimedDueAt: Date;
  task: { status: string; mode: string; dueAt: Date } | null;
  property: {
    deletedAt: string | null;
    isDncLocked: boolean;
    status: string | null;
    state: string | null;
    outreachDispo: string | null;
  } | null;
  contact: { doNotContact: boolean; smsOptedOut: boolean; firstName: string | null } | null;
  consentState: ConsentState;
  needsFirstName: boolean;
};

export function decideReminder(i: DecideReminderInputs): ReminderDecision {
  if (!i.task || i.task.status !== "open" || i.task.mode !== "phone"
      || i.task.dueAt.getTime() !== i.claimedDueAt.getTime()) {
    return { action: "cancel", reason: "task_changed" };
  }
  if (i.now.getTime() >= i.task.dueAt.getTime()) return { action: "skip", reason: "appointment_passed" };
  if (!i.property || i.property.deletedAt) return { action: "skip", reason: "property_unavailable" };
  if (i.property.isDncLocked) return { action: "skip", reason: "dnc_locked" };
  if (i.property.status && CLOSED_PROPERTY_STATUSES.has(i.property.status)) {
    return { action: "skip", reason: "property_closed" };
  }
  if (!i.contact) return { action: "skip", reason: "no_contact" };
  // The manual variant on purpose: the automated one blocks `booked_appointment` by design.
  const suppression = evaluateSuppression({
    outreachDispo: i.property.outreachDispo,
    consentState: i.consentState,
    doNotContact: i.contact.doNotContact,
    smsOptedOut: i.contact.smsOptedOut,
  });
  if (suppression.suppressed) {
    const reason =
      suppression.source === "consent_state" || suppression.source === "sms_opted_out"
        ? "opted_out"
        : suppression.source === "do_not_contact"
          ? "do_not_contact"
          : "suppressed_dispo";
    return { action: "skip", reason };
  }
  // `no_consent` is not a block: this is an informational message about an appointment, STOP is honored above.
  if (i.needsFirstName && !i.contact.firstName?.trim()) return { action: "skip", reason: "no_first_name" };
  const localTime = formatReminderLocalTime(i.task.dueAt, i.property.state);
  const local = getQuietHoursLocalTime(i.property.state, i.now);
  if (!localTime || !local) return { action: "skip", reason: "unknown_state" };
  if (local.hour < 8 || local.hour >= 21) return quietHoursDecision(i.property.state, i.now, i.task.dueAt);
  return { action: "send", localTime };
}

function quietHoursDecision(state: string | null, now: Date, dueAt: Date): ReminderDecision {
  const retryAt = nextQuietHoursOpen(state, now);
  if (!retryAt || retryAt.getTime() > dueAt.getTime() - MIN_LEAD_BEFORE_CALL_MS) {
    return { action: "skip", reason: "quiet_hours_missed" };
  }
  return { action: "defer", reason: "quiet_hours", retryAt };
}

// ---------------------------------------------------------------- dispatch

export type ClaimedSellerReminder = {
  id: string;
  org_id: string;
  task_id: string;
  calendar_chain_id: string;
  property_id: string;
  contact_id: string | null;
  due_at: string;
  send_at: string;
  send_local_date: string;
  attempts: number;
  claim_token: string;
  send_key: string;
};

type Result<T> = PromiseLike<{ data: T | null; error: { message?: string; code?: string } | null }>;
export type SellerReminderAdmin = {
  rpc(fn: string, args?: Record<string, unknown>): Result<unknown>;
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: unknown): {
        maybeSingle(): Result<Record<string, unknown>>;
      } & PromiseLike<{ data: Record<string, unknown>[] | null; error: { message?: string } | null }>;
    };
  };
};

export type SellerReminderDeps = {
  admin: SellerReminderAdmin;
  send: (input: SendSmsInput) => Promise<SendSmsOutcome>;
  getConsent: (contactId: string) => Promise<ConsentState>;
  /** Per-org `seller_reminders` kill switch; missing reads as off. */
  getFlag: (orgId: string) => Promise<boolean>;
  schemaReady: () => Promise<boolean>;
  getCopy?: () => string | null;
  now?: () => Date;
  newSendKey?: () => string;
  budgetMs?: number;
  report?: (error: unknown, surface: string) => void;
};

export type DispatchResult =
  | { status: "sent" | "skipped" | "cancelled" | "failed" | "uncertain"; reason?: string }
  | { status: "pending"; reason: string; retryAt: Date }
  | { status: "fence_lost" };

async function one(
  admin: SellerReminderAdmin,
  table: string,
  columns: string,
  idColumn: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const { data, error } = await admin.from(table).select(columns).eq(idColumn, id).maybeSingle();
  if (error) throw new Error(`${table} read failed: ${error.message ?? "unknown"}`);
  return data;
}

async function many(
  admin: SellerReminderAdmin,
  table: string,
  columns: string,
  idColumn: string,
  id: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await admin.from(table).select(columns).eq(idColumn, id);
  if (error) throw new Error(`${table} read failed: ${error.message ?? "unknown"}`);
  return data ?? [];
}

async function finish(
  admin: SellerReminderAdmin,
  row: ClaimedSellerReminder,
  args: {
    status: "sent" | "skipped" | "cancelled" | "failed" | "uncertain" | "pending";
    reason?: string;
    messageId?: string;
    retryAt?: Date;
    newSendKey?: string;
  },
): Promise<boolean> {
  const { data, error } = await admin.rpc("fn_finish_seller_reminder", {
    p_id: row.id,
    p_token: row.claim_token,
    p_status: args.status,
    p_reason: args.reason ?? null,
    p_message_id: args.messageId ?? null,
    p_retry_at: args.retryAt ? args.retryAt.toISOString() : null,
    p_new_send_key: args.newSendKey ?? null,
  });
  if (error) throw new Error(`fn_finish_seller_reminder failed: ${error.message ?? "unknown"}`);
  return data === true;
}

function storedProvesNotSent(m: Record<string, unknown>): boolean {
  const meta = m.metadata && typeof m.metadata === "object" ? (m.metadata as Record<string, unknown>) : null;
  const attempt = meta?.providerAttempt as Record<string, unknown> | undefined;
  return attempt?.outcome === "definitively_rejected" || attempt?.outcome === "not_attempted";
}

/** True unless the messages table proves this key never reached the provider (a failed lookup counts as maybe sent). */
async function mayHaveBeenSent(admin: SellerReminderAdmin, row: ClaimedSellerReminder): Promise<boolean> {
  let stored: Record<string, unknown>[];
  try {
    stored = await many(admin, "messages", "id,org_id,metadata", "idempotency_key", row.send_key);
  } catch {
    return true;
  }
  if (stored.some((m) => m.org_id !== row.org_id)) return true;
  return !stored.every(storedProvesNotSent);
}

export async function dispatchSellerReminder(
  deps: SellerReminderDeps,
  row: ClaimedSellerReminder,
): Promise<DispatchResult> {
  const { admin } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const done = async (
    r: Parameters<typeof finish>[2],
  ): Promise<DispatchResult> => {
    // A reclaimed lease (attempts > 1) may have already sent before the worker died. A cancel, skip or
    // deferral would free the appointment-day slot (only claimed/sent/uncertain hold it) and let a
    // rescheduled successor text the seller again. Hold the slot as `uncertain` unless the stored message
    // row proves nothing went out. Statuses that are already terminal-with-slot (sent, uncertain) and
    // retries with a fresh key (already proven unsent) are untouched.
    const freesSlot = r.status === "cancelled" || r.status === "skipped"
      || (r.status === "pending" && !r.newSendKey);
    if (freesSlot && row.attempts > 1 && (await mayHaveBeenSent(admin, row))) {
      if (!(await finish(admin, row, { status: "uncertain", reason: "unknown_delivery" }))) {
        return { status: "fence_lost" };
      }
      return { status: "uncertain", reason: "unknown_delivery" };
    }
    if (!(await finish(admin, row, r))) return { status: "fence_lost" };
    return r.status === "pending"
      ? { status: "pending", reason: r.reason ?? "", retryAt: r.retryAt! }
      : { status: r.status, reason: r.reason };
  };

  // 0. Recheck both switches and the copy immediately before sending anything.
  const settings = await one(admin, "seller_reminder_settings", "enabled", "org_id", row.org_id);
  const copy = (deps.getCopy ?? (() => SELLER_REMINDER_COPY))();
  if (settings?.enabled !== true || !(await deps.getFlag(row.org_id))) {
    return done({ status: "cancelled", reason: "reminders_disabled" });
  }
  if (copy === null) return done({ status: "cancelled", reason: "copy_not_approved" });

  // 1-2. Re-read everything the decision depends on; never trust the claim snapshot.
  const task = await one(admin, "tasks", "status,mode,due_at,contact_id", "id", row.task_id);
  const property = await one(
    admin, "properties", "org_id,deleted_at,is_dnc_locked,status,state,outreach_dispo,homeowner_contact_id", "id", row.property_id,
  );
  const contactId = (task?.contact_id as string | null) ?? (property?.homeowner_contact_id as string | null) ?? null;
  let contactRow = contactId
    ? await one(admin, "contacts", "org_id,do_not_contact,sms_opted_out,first_name", "id", contactId)
    : null;
  // Tenant and linkage fence: the recipient must belong to this org and be linked to this property.
  if (contactRow && contactId) {
    let linked = contactRow.org_id === row.org_id && property?.org_id === row.org_id
      && property?.homeowner_contact_id === contactId;
    if (!linked && contactRow.org_id === row.org_id && property?.org_id === row.org_id) {
      linked = (await many(admin, "property_contacts", "contact_id", "property_id", row.property_id))
        .some((r) => r.contact_id === contactId);
    }
    if (!linked) contactRow = null;
  }
  const consentState = contactId ? await deps.getConsent(contactId) : "no_consent";

  const decision = decideReminder({
    now,
    claimedDueAt: new Date(row.due_at),
    task: task
      ? { status: String(task.status), mode: String(task.mode), dueAt: new Date(String(task.due_at)) }
      : null,
    property: property
      ? {
          deletedAt: (property.deleted_at as string | null) ?? null,
          isDncLocked: property.is_dnc_locked === true,
          status: (property.status as string | null) ?? null,
          state: (property.state as string | null) ?? null,
          outreachDispo: (property.outreach_dispo as string | null) ?? null,
        }
      : null,
    contact: contactRow
      ? {
          doNotContact: contactRow.do_not_contact === true,
          smsOptedOut: contactRow.sms_opted_out === true,
          firstName: (contactRow.first_name as string | null) ?? null,
        }
      : null,
    consentState,
    needsFirstName: copyNeedsFirstName(copy),
  });
  if (decision.action === "cancel") return done({ status: "cancelled", reason: decision.reason });
  if (decision.action === "skip") return done({ status: "skipped", reason: decision.reason });
  if (decision.action === "defer") {
    return done({ status: "pending", reason: decision.reason, retryAt: decision.retryAt });
  }

  // 3. Send through the existing transport. origin "manual" is deliberate: "automated" re-checks
  // HUMAN_OWNED_DISPOS and would always block a booked appointment, and the human decided to send this
  // reminder when he scheduled the call. The handler performed the gates above; the transport repeats
  // consent, quiet hours, provider, line type, phone suppression and sender approval.
  const body = buildSellerReminderBody(copy, {
    firstName: (contactRow?.first_name as string | null) ?? null,
    localTime: decision.localTime,
  });
  const outcome = await deps.send({
    origin: "manual",
    contactId: contactId!,
    propertyId: row.property_id,
    body,
    idempotencyKey: row.send_key,
    metadata: { kind: "seller_appointment_reminder", reminderId: row.id, taskId: row.task_id },
  });
  return mapOutcome(deps, row, outcome, now, new Date(row.due_at), done, property?.state as string | null);
}

function mapOutcome(
  deps: SellerReminderDeps,
  row: ClaimedSellerReminder,
  outcome: SendSmsOutcome,
  now: Date,
  dueAt: Date,
  done: (r: Parameters<typeof finish>[2]) => Promise<DispatchResult>,
  state: string | null,
): Promise<DispatchResult> {
  switch (outcome.status) {
    case "sent":
      return done({ status: "sent", messageId: outcome.messageId });
    case "queued":
    case "paused":
      // A message row exists but nothing was dispatched by us: hold it, never resend.
      return done({ status: "uncertain", reason: `unexpected_${outcome.status}`, messageId: outcome.messageId });
    case "blocked_quiet_hours": {
      const d = quietHoursDecision(state, now, dueAt);
      if (d.action === "defer") return done({ status: "pending", reason: d.reason, retryAt: d.retryAt });
      return done({ status: "skipped", reason: "quiet_hours_missed" });
    }
    case "provider_unknown":
      return done({ status: "uncertain", reason: "unknown_delivery", messageId: outcome.messageId });
    case "db_error":
      // The transport refuses a first text in a thread that does not name "Mel with BMH" (a fixed opener
      // rule in send.ts). Nothing was sent and retrying cannot change the answer: skip with a clear reason.
      if (outcome.error === openingIdentityError("")) {
        return done({ status: "skipped", reason: "opening_identity_required" });
      }
      // A message row, provider receipt, or a key already bound to different content means the provider
      // may have accepted: terminal, never resent.
      if (outcome.messageId || outcome.externalId
          || outcome.deliveryOutcome === "accepted" || outcome.deliveryOutcome === "unknown"
          || /idempotency key was already used/i.test(outcome.error)) {
        return done({ status: "uncertain", reason: "unknown_delivery", messageId: outcome.messageId });
      }
      return retry(deps, row, now, dueAt, done, "db_error", false);
    case "provider_failed":
      // Retry with a new key ONLY on proof that nothing was sent.
      if (outcome.deliveryOutcome === "accepted" || outcome.deliveryOutcome === "unknown") {
        return done({ status: "uncertain", reason: "unknown_delivery", messageId: outcome.messageId });
      }
      return retry(deps, row, now, dueAt, done, "provider_failed", outcome.providerAttempted === false);
    case "provider_deferred":
      return retry(deps, row, now, dueAt, done, "provider_deferred", false);
    default:
      // blocked_*, contact_not_found, property_not_found, skipped_duplicate_destination
      return done({ status: "skipped", reason: outcome.status });
  }
}

/**
 * Re-queue with a FRESH persisted UUID v4 (the transport replays a reused key) ONLY on proof that nothing
 * was sent: the transport said the provider was never attempted, or the stored message row records
 * `providerAttempt.outcome` as `definitively_rejected` / `not_attempted`. Any message row for this key
 * without that proof, or a failed lookup, means delivery is unknown: terminal `uncertain`, no resend.
 */
async function retry(
  deps: SellerReminderDeps,
  row: ClaimedSellerReminder,
  now: Date,
  dueAt: Date,
  done: (r: Parameters<typeof finish>[2]) => Promise<DispatchResult>,
  reason: string,
  transportProvedNotAttempted: boolean,
): Promise<DispatchResult> {
  const uncertain = () => done({ status: "uncertain", reason: "unknown_delivery" });
  let stored: Record<string, unknown>[];
  try {
    stored = await many(deps.admin, "messages", "id,org_id,metadata", "idempotency_key", row.send_key);
  } catch {
    return uncertain();
  }
  const mine = stored.filter((m) => m.org_id === row.org_id);
  if (stored.length !== mine.length) return uncertain();
  let proof: boolean;
  if (transportProvedNotAttempted) {
    proof = true;
  } else if (mine.length > 0) {
    proof = mine.every(storedProvesNotSent);
  } else {
    // No stored message for this key: a db_error or deferral before anything was written dispatched
    // nothing. A provider_failed outcome with no row and no proof is unknown.
    proof = reason !== "provider_failed";
  }
  if (!proof) return uncertain();
  const retryAt = new Date(now.getTime() + row.attempts * RETRY_STEP_MS);
  if (row.attempts >= REMINDER_MAX_ATTEMPTS || retryAt.getTime() >= dueAt.getTime()) {
    return done({ status: "failed", reason });
  }
  return done({
    status: "pending",
    reason,
    retryAt,
    newSendKey: (deps.newSendKey ?? randomUUID)(),
  });
}

// ---------------------------------------------------------------- job

export type SellerReminderJobResult =
  | { ok: true; disabled: "flag_off" | "copy_not_approved" | "settings_unavailable" }
  | {
      ok: true;
      schedule: unknown;
      claimed: number;
      results: Record<string, number>;
      budgetExhausted: boolean;
    };

export async function runSellerReminderJob(deps: SellerReminderDeps): Promise<SellerReminderJobResult> {
  const { admin } = deps;
  const now = deps.now ?? (() => new Date());
  const getCopy = deps.getCopy ?? (() => SELLER_REMINDER_COPY);

  // (0) Both switches before scheduling or claiming anything.
  if (!(await deps.schemaReady())) return { ok: true, disabled: "flag_off" };
  const enabled = await admin.from("seller_reminder_settings").select("org_id").eq("enabled", true);
  if (enabled.error) {
    deps.report?.(enabled.error, "seller_reminder_settings_read");
    return { ok: true, disabled: "settings_unavailable" };
  }
  const orgIds: string[] = [];
  for (const r of enabled.data ?? []) {
    const orgId = String(r.org_id);
    if (await deps.getFlag(orgId)) orgIds.push(orgId);
  }
  if (orgIds.length === 0) return { ok: true, disabled: "flag_off" };
  if (getCopy() === null) return { ok: true, disabled: "copy_not_approved" };

  // (1) schedule
  const scheduled = await admin.rpc("fn_schedule_seller_reminders", { p_org_ids: orgIds });
  if (scheduled.error) throw new Error(`fn_schedule_seller_reminders failed: ${scheduled.error.message ?? "unknown"}`);

  // (2) budget loop, one claim per iteration
  const started = now().getTime();
  const budget = deps.budgetMs ?? 45_000;
  const results: Record<string, number> = {};
  let claimed = 0;
  let budgetExhausted = false;
  for (;;) {
    if (now().getTime() - started >= budget) { budgetExhausted = true; break; }
    const claim = await admin.rpc("fn_claim_seller_reminders", { p_limit: 1, p_org_ids: orgIds });
    if (claim.error) throw new Error(`fn_claim_seller_reminders failed: ${claim.error.message ?? "unknown"}`);
    const rows = (claim.data ?? []) as ClaimedSellerReminder[];
    if (rows.length === 0) break;
    for (const row of rows) {
      claimed += 1;
      let key: string;
      try {
        const r = await dispatchSellerReminder(deps, row);
        key = r.status === "pending" || r.status === "fence_lost" ? r.status : `${r.status}${r.reason ? `:${r.reason}` : ""}`;
      } catch (error) {
        // Leave the lease: it is reclaimed after 10 minutes with the same key, which the transport replays safely.
        deps.report?.(error, "seller_reminder_dispatch");
        key = "error";
      }
      results[key] = (results[key] ?? 0) + 1;
    }
  }
  return { ok: true, schedule: scheduled.data, claimed, results, budgetExhausted };
}
