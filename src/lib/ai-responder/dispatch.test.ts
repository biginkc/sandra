import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConsentState } from "@/lib/messaging/consent";
import { applyPhoneLevelOptOut } from "@/lib/messaging/opt-out-phone";
import { sendSmsToContact } from "@/lib/messaging/send";
import { classifyForDispatch } from "@/lib/sms-classification/dispatch-bridge";

import { classifyAiSkip } from "./classify";
import { dispatchAiResponse, resolveOutboundPolicy, sendReservationTuning } from "./dispatch";
import { generateAiReply } from "./generate";
import { humanizeReply } from "./humanize";
import { IDENTITY_REPLY_BODY } from "./identity";
import { validateAiReplyBody } from "./safety";
import type { AiStructuredOutput } from "./types";

const { recordLeadEvent, reportErrorMock } = vi.hoisted(() => ({
  recordLeadEvent: vi.fn(),
  reportErrorMock: vi.fn(),
}));

vi.mock("@/lib/errors/report", () => ({ reportError: reportErrorMock }));

vi.mock("@/lib/sms-classification/dispatch-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sms-classification/dispatch-bridge")>();
  return { ...actual, classifyForDispatch: vi.fn(actual.classifyForDispatch) };
});

vi.mock("@/lib/events", () => ({
  LEAD_EVENT_TYPES: {
    AI_ESCALATED: "ai_escalated",
    DISPO_SET: "dispo_set",
    QUALIFIED: "qualified",
  },
  recordLeadEvent,
}));

vi.mock("@/lib/messaging/consent", () => ({
  getConsentState: vi.fn(),
}));

vi.mock("@/lib/messaging/quiet-hours", () => ({
  checkQuietHours: vi.fn(() => ({ ok: true })),
}));

vi.mock("@/lib/messaging/send", () => ({
  sendSmsToContact: vi.fn(),
}));

vi.mock("@/lib/messaging/opt-out-phone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/messaging/opt-out-phone")>();
  return { ...actual, applyPhoneLevelOptOut: vi.fn() };
});

vi.mock("@/lib/sequences/enrollment", () => ({
  pauseContactEnrollments: vi.fn(),
  pausePropertyEnrollments: vi.fn(),
}));

vi.mock("./classify", () => ({
  classifyAiSkip: vi.fn(),
}));

vi.mock("./generate", () => ({
  classifyProviderFailure: vi.fn(() => null),
  generateAiReply: vi.fn(),
}));

vi.mock("./humanize", () => ({
  humanizeReply: vi.fn(),
}));

vi.mock("./safety", () => ({
  validateAiReplyBody: vi.fn(),
}));

type MessageRow = {
  id: string;
  body: string | null;
  campaign_id?: string | null;
  channel: string;
  contact_id: string;
  conversation_id: string | null;
  created_at: string;
  direction: "inbound" | "outbound";
  metadata: Record<string, unknown> | null;
  property_id: string;
  scheduled_for?: string | null;
  sent_at: string | null;
  status: string;
};

type AiClaimRow = {
  error_message?: string | null;
  id: string;
  inbound_message_id: string;
  lease_expires_at: string;
  outcome?: string | null;
  response_kind: string;
  status: string;
};

type MockState = {
  aiDispositionRpcCalls: number;
  aiDispositionRpcErrorsRemaining: number;
  aiDispoReviews: Array<{
    conversationId: string;
    disposition: string;
    inboundMessageId: string;
    reason: string;
  }>;
  aiClaims: AiClaimRow[];
  aiClaimInsertError?: boolean;
  aiReplyDrafts?: Array<Record<string, unknown>>;
  /** Insert into ai_reply_drafts fails with this error (code optional). */
  draftInsertError?: { code?: string; message: string };
  /** Active reservations by conversation key (holder + expiry ms). */
  sendReservations?: Map<string, { holder: string; expiresAt: number }>;
  reserveRpcError?: boolean;
  /** fn_renew_ai_send returns false (the lease was lost before the provider call). */
  renewLost?: boolean;
  /** Active-config re-read errors / finds no row (fail-closed hold). */
  configReadError?: boolean;
  configMissing?: boolean;
  /** message ids that sequence_step_runs links to (drip ticks). */
  sequenceMessageIds?: string[];
  sequenceLookupError?: boolean;
  deadLetters?: Array<Record<string, unknown>>;
  deadLetterInsertError?: { message: string };
  deadLetterInsertAttempts?: number;
  /** fn_renew_ai_send returns an error. */
  renewError?: boolean;
  /** ensure_sms_conversation_id returns an error. */
  ensureConversationError?: boolean;
  /** The next N ai_response_claims updates fail. */
  claimUpdateFailures?: number;
  /** Drafts' select/update errors. */
  draftLookupError?: boolean;
  /** Called with the 1-based index of each ai_reply_drafts SELECT; may pause it. */
  draftSelectHook?: (n: number) => Promise<void> | void;
  draftSelectCount?: number;
  reserveCalls?: number;
  /** The max-turns count query returns a DB error. */
  turnCountError?: boolean;
  /** Destination phones present in sms_phone_suppressions. */
  phoneSuppressions?: string[];
  phoneSuppressionError?: boolean;
  /** Property attention-flag writes fail (update returns an error). */
  flagWriteError?: boolean;
  /** A messages lookup for this direction returns a DB error. */
  messageLookupError?: "inbound" | "outbound";
  /** Hook run once inside fn_reserve_ai_send's winner path (race injection). */
  onReserved?: () => void;
  jevOutcomeThresholds?: Array<{ outcome: string; min_confidence: number; version?: number; automation_enabled?: boolean }>;
  jevLeadDecisionCalls: Array<{ rpc: string; args: Record<string, unknown> }>;
  contact: {
    first_name: string | null;
    phone_1: string | null;
    phone_1_type: string | null;
    phone_2: string | null;
    phone_2_type: string | null;
    phone_3: string | null;
    phone_3_type: string | null;
    do_not_contact?: boolean | null;
    sms_opted_out?: boolean | null;
  };
  config: {
    active: boolean;
    business_hours_only: boolean;
    classifier_mode?: "shadow" | "automatic";
    classifier_provider?: "legacy" | "jev";
    escalation_keywords: string[];
    id: string;
    max_turns: number;
    min_confidence: number;
    model: string;
    outbound_mode?: string;
    system_prompt: string;
  };
  smsClassificationRuns: Array<{ id: string }>;
  messages: MessageRow[];
  nextMessageId: number;
  nextClaimId: number;
  property: {
    ai_responder_disabled: boolean;
    id: string;
    homeowner_contact_id: string;
    needs_human_attention: boolean;
    last_ai_escalation_reason?: string | null;
    org_id: string;
    outreach_dispo: string | null;
    state: string;
    status?: string;
    is_dnc_locked?: boolean;
    qualified_at?: string | null;
    qualified_by?: string | null;
  };
  threadConversationId: string;
};

const defaultReservationTuning = { ...sendReservationTuning };
const PROPERTY_ID = "property-1";
const CONTACT_ID = "contact-1";
const CONVERSATION_ID = "conversation-1";

const HAPPY_REPLY: AiStructuredOutput = {
  action: "send_reply",
  body: "Hi there",
  confidence: 0.91,
  sentiment: "neutral",
};

function createMockState(): MockState {
  return {
    aiDispositionRpcCalls: 0,
    aiDispositionRpcErrorsRemaining: 0,
    aiDispoReviews: [],
    config: {
      active: true,
      business_hours_only: false,
      escalation_keywords: [],
      id: "config-1",
      max_turns: 10,
      min_confidence: 0.7,
      model: "claude-test",
      system_prompt: "Reply briefly.",
    },
    aiClaims: [],
    jevLeadDecisionCalls: [],
    smsClassificationRuns: [],
    contact: {
      first_name: "Sam",
      phone_1: "+18165550001",
      phone_1_type: "mobile",
      phone_2: null,
      phone_2_type: null,
      phone_3: null,
      phone_3_type: null,
    },
    messages: [],
    nextClaimId: 1,
    nextMessageId: 1,
    property: {
      ai_responder_disabled: false,
      homeowner_contact_id: CONTACT_ID,
      id: PROPERTY_ID,
      needs_human_attention: false,
      org_id: "org-1",
      outreach_dispo: null,
      state: "MO",
      status: "prospect",
      is_dnc_locked: false,
      qualified_at: null,
      qualified_by: null,
    },
    threadConversationId: CONVERSATION_ID,
  };
}

function createMockSupabase(state: MockState) {
  function matchesMessage(
    row: MessageRow,
    filters: {
      contains: Map<string, Record<string, unknown>>;
      eq: Map<string, unknown>;
      in: Map<string, unknown[]>;
      neq: Map<string, unknown>;
      lte: Map<string, unknown>;
      predicates?: Array<(row: MessageRow) => boolean>;
    },
  ): boolean {
    for (const predicate of filters.predicates ?? []) {
      if (!predicate(row)) return false;
    }
    for (const [field, value] of filters.eq) {
      if (row[field as keyof MessageRow] !== value) {
        return false;
      }
    }

    for (const [field, value] of filters.neq) {
      if (row[field as keyof MessageRow] === value) {
        return false;
      }
    }

    for (const [field, value] of filters.lte) {
      const cell = row[field as keyof MessageRow];
      if (typeof cell !== "string" || typeof value !== "string" || !(cell <= value)) {
        return false;
      }
    }

    for (const [field, values] of filters.in) {
      const cell = row[field as keyof MessageRow];
      if (!values.includes(cell)) {
        return false;
      }
    }

    for (const [field, value] of filters.contains) {
      const cell = row[field as keyof MessageRow];
      if (!cell || typeof cell !== "object" || Array.isArray(cell)) {
        return false;
      }
      const record = cell as Record<string, unknown>;
      if (
        Object.entries(value).some(
          ([key, expected]) => record[key] !== expected,
        )
      ) {
        return false;
      }
    }

    return true;
  }

  function buildMessagesQuery() {
    const filters = {
      contains: new Map<string, Record<string, unknown>>(),
      eq: new Map<string, unknown>(),
      in: new Map<string, unknown[]>(),
      neq: new Map<string, unknown>(),
      lte: new Map<string, unknown>(),
      predicates: [] as Array<(row: MessageRow) => boolean>,
    };
    let limitCount: number | null = null;
    let orderBy: { ascending: boolean; field: keyof MessageRow } | null = null;
    let selectOptions: { count?: string; head?: boolean } | undefined;
    let updateData: Partial<MessageRow> | null = null;
    let turnCountFails = false;

    const execute = () => {
      if (turnCountFails) {
        return { data: null, error: { message: "turn count boom" } as { message: string } | null };
      }
      if (
        !updateData &&
        state.messageLookupError &&
        filters.eq.get("direction") === state.messageLookupError
      ) {
        return { data: null, error: { message: "lookup boom" } as { message: string } | null };
      }
      if (updateData) {
        for (const row of state.messages) {
          if (matchesMessage(row, filters)) {
            Object.assign(row, updateData);
          }
        }
        return { data: null, error: null };
      }

      let rows = state.messages.filter((row) => matchesMessage(row, filters));
      if (orderBy) {
        const { ascending, field } = orderBy;
        rows = rows.slice().sort((left, right) => {
          const leftValue = String(left[field] ?? "");
          const rightValue = String(right[field] ?? "");
          return ascending
            ? leftValue < rightValue
              ? -1
              : leftValue > rightValue
                ? 1
                : 0
            : leftValue > rightValue
              ? -1
              : leftValue < rightValue
                ? 1
                : 0;
        });
      }
      if (typeof limitCount === "number") {
        rows = rows.slice(0, limitCount);
      }

      if (selectOptions?.head && selectOptions.count === "exact") {
        return { count: rows.length, data: null, error: null };
      }

      return { data: rows, error: null };
    };

    const query = {
      contains(field: string, value: Record<string, unknown>) {
        filters.contains.set(field, value);
        return query;
      },
      eq(field: string, value: unknown) {
        filters.eq.set(field, value);
        return query;
      },
      in(field: string, values: unknown[]) {
        filters.in.set(field, values);
        return query;
      },
      neq(field: string, value: unknown) {
        filters.neq.set(field, value);
        return query;
      },
      lte(field: string, value: unknown) {
        filters.lte.set(field, value);
        return query;
      },
      // `sent_at.gte.X,and(sent_at.is.null,created_at.gte.X)`: went out since X
      // (submission time, falling back to creation time).
      or(filter: string) {
        if (filter.includes("abortedBeforeProvider")) {
          // metadata->>abortedBeforeProvider IS NULL OR <> 'true' (max-turns count)
          if (state.turnCountError) {
            filters.predicates.push(() => true);
            turnCountFails = true;
            return query;
          }
          filters.predicates.push((row) => row.metadata?.abortedBeforeProvider !== true);
          return query;
        }
        const iso = /sent_at\.gte\.([^,]+),/.exec(filter)?.[1] ?? "";
        filters.predicates.push((row) =>
          row.sent_at ? row.sent_at >= iso : row.created_at >= iso,
        );
        return query;
      },
      // metadata->aborted_inbound_message_id IS NOT NULL
      not(field: string, _op: string, _value: unknown) {
        if (field === "metadata->aborted_inbound_message_id") {
          filters.predicates.push(
            (row) => row.metadata?.aborted_inbound_message_id !== undefined,
          );
        }
        return query;
      },
      limit(value: number) {
        limitCount = value;
        return query;
      },
      maybeSingle() {
        const result = execute();
        return Promise.resolve({
          data: Array.isArray(result.data) ? (result.data[0] ?? null) : null,
          error: result.error,
        });
      },
      order(field: keyof MessageRow, options?: { ascending?: boolean }) {
        orderBy = { ascending: options?.ascending ?? true, field };
        return query;
      },
      select(_fields: string, options?: { count?: string; head?: boolean }) {
        selectOptions = options;
        return query;
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((value: {
              count?: number | null;
              data: MessageRow[] | null;
              error: { message: string } | null;
            }) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(execute()).then(onfulfilled, onrejected);
      },
      update(value: Partial<MessageRow>) {
        updateData = value;
        return query;
      },
    };

    return query;
  }

  function buildPropertiesQuery() {
    let updateData: Partial<MockState["property"]> | null = null;
    const eqFilters = new Map<string, unknown>();
    let allowedDispos: string[] | null = null;
    let allowsNullDispo = false;

    const matchesCurrentProperty = () => {
      for (const [field, value] of eqFilters) {
        if (state.property[field as keyof MockState["property"]] !== value) {
          return false;
        }
      }
      if (allowedDispos) {
        const current = state.property.outreach_dispo;
        if (current === null) return allowsNullDispo;
        return allowedDispos.includes(current);
      }
      return true;
    };

    const execute = () => {
      if (updateData) {
        if (state.flagWriteError && "needs_human_attention" in updateData) {
          return { data: null, error: { message: "flag boom" } };
        }
        if (!matchesCurrentProperty()) {
          return { data: null, error: null };
        }
        Object.assign(state.property, updateData);
        return { data: { id: state.property.id }, error: null };
      }
      return { data: { ...state.property }, error: null };
    };

    const query = {
      eq(field: string, value: unknown) {
        eqFilters.set(field, value);
        return query;
      },
      is(field: string, value: unknown) {
        eqFilters.set(field, value);
        return query;
      },
      maybeSingle() {
        return Promise.resolve(execute());
      },
      or(filter: string) {
        allowsNullDispo = filter.includes("outreach_dispo.is.null");
        const match = filter.match(/outreach_dispo\.in\.\(([^)]*)\)/);
        allowedDispos = match?.[1] ? match[1].split(",").filter(Boolean) : null;
        return query;
      },
      update(value: Partial<MockState["property"]>) {
        updateData = value;
        return query;
      },
      then<TResult1 = unknown, TResult2 = never>(
        onfulfilled?:
          | ((
              value: ReturnType<typeof execute>,
            ) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(execute()).then(onfulfilled, onrejected);
      },
      select() {
        return query;
      },
    };

    return query;
  }

  function buildConfigQuery() {
    const query = {
      eq() {
        return query;
      },
      maybeSingle() {
        if (state.configReadError) {
          return Promise.resolve({ data: null, error: { message: "config boom" } });
        }
        if (state.configMissing) {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({
          data: state.config,
          error: null,
        });
      },
      select() {
        return query;
      },
    };

    return query;
  }

  function buildContactsQuery() {
    const query = {
      eq() {
        return query;
      },
      maybeSingle() {
        return Promise.resolve({
          data: state.contact,
          error: null,
        });
      },
      select() {
        return query;
      },
    };

    return query;
  }

  function buildAiClaimsQuery() {
    const eqFilters = new Map<string, unknown>();
    let insertData: Partial<AiClaimRow> | null = null;
    let updateData: Partial<AiClaimRow> | null = null;

    const matches = (row: AiClaimRow) => {
      for (const [field, value] of eqFilters) {
        if (row[field as keyof AiClaimRow] !== value) return false;
      }
      return true;
    };

    const execute = () => {
      if (insertData) {
        if (state.aiClaimInsertError) {
          return {
            data: null,
            error: {
              code: "42P01",
              message: "relation ai_response_claims does not exist",
            },
          };
        }
        if (
          state.aiClaims.some(
            (row) =>
              row.inbound_message_id === insertData!.inbound_message_id &&
              row.response_kind === insertData!.response_kind,
          )
        ) {
          return {
            data: null,
            error: {
              code: "23505",
              message: "duplicate key value violates unique constraint",
            },
          };
        }
        const row: AiClaimRow = {
          id: `claim-${state.nextClaimId++}`,
          inbound_message_id: String(insertData.inbound_message_id),
          lease_expires_at: String(insertData.lease_expires_at),
          response_kind: String(insertData.response_kind),
          status: String(insertData.status),
        };
        state.aiClaims.push(row);
        return { data: row, error: null };
      }

      if (updateData) {
        if ((state.claimUpdateFailures ?? 0) > 0) {
          state.claimUpdateFailures = (state.claimUpdateFailures ?? 0) - 1;
          return { data: null, error: { code: "XX000", message: "claim update boom" } };
        }
        const row = state.aiClaims.find(matches);
        if (!row) return { data: null, error: null };
        Object.assign(row, updateData);
        return { data: row, error: null };
      }

      return {
        data: state.aiClaims.find(matches) ?? null,
        error: null,
      };
    };

    const query = {
      eq(field: string, value: unknown) {
        eqFilters.set(field, value);
        return query;
      },
      insert(value: Partial<AiClaimRow>) {
        insertData = value;
        return query;
      },
      maybeSingle() {
        return Promise.resolve(execute());
      },
      select() {
        return query;
      },
      single() {
        return Promise.resolve(execute());
      },
      then<TResult1 = ReturnType<typeof execute>, TResult2 = never>(
        onfulfilled?:
          | ((
              value: ReturnType<typeof execute>,
            ) => TResult1 | PromiseLike<TResult1>)
          | null,
        onrejected?:
          ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(execute()).then(onfulfilled, onrejected);
      },
      update(value: Partial<AiClaimRow>) {
        updateData = value;
        return query;
      },
    };

    return query;
  }

  function buildAiDispositionReviewsQuery() {
    const eqFilters = new Map<string, unknown>();
    const query = {
      eq(field: string, value: unknown) {
        eqFilters.set(field, value);
        return query;
      },
      maybeSingle() {
        const inboundMessageId = eqFilters.get("source_inbound_message_id");
        const review = state.aiDispoReviews.find(
          (row) => row.inboundMessageId === inboundMessageId,
        );
        return Promise.resolve({
          data: review ? { disposition: review.disposition } : null,
          error: null,
        });
      },
      select() {
        return query;
      },
    };
    return query;
  }

  function buildSmsClassificationRunsQuery() {
    const query = {
      insert() {
        const row = { id: `run-${state.smsClassificationRuns.length + 1}` };
        state.smsClassificationRuns.push(row);
        return {
          select: () => ({
            maybeSingle: async () => ({ data: row, error: null }),
          }),
        };
      },
      eq() {
        return query;
      },
      select() {
        return query;
      },
      maybeSingle() {
        return Promise.resolve({
          data: state.smsClassificationRuns.at(-1) ?? null,
          error: null,
        });
      },
    };
    return query;
  }

  function buildJevOutcomeThresholdsQuery() {
    const query = {
      select() {
        return query;
      },
      async eq() {
        // Defaults to no configured thresholds — every outcome resolves
        // human_gated, matching this suite's existing expectation that
        // Jev routes never auto-apply without a test opting a threshold
        // in via `state.jevOutcomeThresholds`. `version` defaults to 1
        // when a test omits it.
        return {
          data: (state.jevOutcomeThresholds ?? []).map((t) => ({ automation_enabled: true, ...t, version: t.version ?? 1 })),
          error: null,
        };
      },
    };
    return query;
  }

  return {
    from(table: string) {
      if (table === "messages") {
        return buildMessagesQuery();
      }
      if (table === "properties") {
        return buildPropertiesQuery();
      }
      if (table === "ai_responder_configs") {
        return buildConfigQuery();
      }
      if (table === "contacts") {
        return buildContactsQuery();
      }
      if (table === "sms_phone_suppressions") {
        const q = {
          select: () => q,
          eq: () => q,
          limit: () =>
            Promise.resolve(
              state.phoneSuppressionError
                ? { data: null, error: { message: "suppression boom" } }
                : {
                    data: (state.phoneSuppressions ?? []).length > 0 ? [{ id: "sup-1" }] : [],
                    error: null,
                  },
            ),
        };
        return q;
      }
      if (table === "ai_response_claims") {
        return buildAiClaimsQuery();
      }
      if (table === "ai_disposition_reviews") {
        return buildAiDispositionReviewsQuery();
      }
      if (table === "sms_classification_runs") {
        return buildSmsClassificationRunsQuery();
      }
      if (table === "jev_outcome_thresholds") {
        return buildJevOutcomeThresholdsQuery();
      }
      if (table === "sequence_step_runs") {
        const q = {
          select: () => q,
          in: (_field: string, ids: string[]) =>
            Promise.resolve(
              state.sequenceLookupError
                ? { data: null, error: { message: "sequence boom" } }
                : {
                    data: (state.sequenceMessageIds ?? [])
                      .filter((id) => ids.includes(id))
                      .map((id) => ({ message_id: id })),
                    error: null,
                  },
            ),
        };
        return q;
      }
      if (table === "ai_reply_dead_letters") {
        return {
          insert: async (row: Record<string, unknown>) => {
            state.deadLetterInsertAttempts = (state.deadLetterInsertAttempts ?? 0) + 1;
            if (state.deadLetterInsertError) return { error: state.deadLetterInsertError };
            (state.deadLetters ??= []).push(row);
            return { error: null };
          },
        };
      }
      if (table === "ai_reply_drafts") {
        const drafts = () => (state.aiReplyDrafts ??= []);
        const filters = new Map<string, unknown>();
        let updateData: Record<string, unknown> | null = null;
        const q = {
          select: () => q,
          eq(field: string, value: unknown) {
            filters.set(field, value);
            return q;
          },
          order: () => q,
          limit: () => q,
          update(value: Record<string, unknown>) {
            updateData = value;
            return q;
          },
          then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
            const run = () => {
              if (state.draftLookupError) return { data: null, error: { message: "draft lookup boom" } };
              const matches = drafts().filter((d) =>
                [...filters].every(([k, v]) => d[k] === v),
              );
              if (updateData) {
                for (const d of matches) Object.assign(d, updateData);
                return { data: null, error: null };
              }
              return { data: matches.slice().reverse(), error: null };
            };
            if (!updateData && state.draftSelectHook) {
              state.draftSelectCount = (state.draftSelectCount ?? 0) + 1;
              const paused = state.draftSelectHook(state.draftSelectCount);
              return Promise.resolve(paused).then(run).then(resolve, reject);
            }
            return Promise.resolve(run()).then(resolve, reject);
          },
          insert: async (row: Record<string, unknown>) => {
            if (state.draftInsertError) return { error: state.draftInsertError };
            if (
              row.status === "pending" &&
              row.inbound_message_id &&
              drafts().some(
                (d) => d.status === "pending" && d.inbound_message_id === row.inbound_message_id,
              )
            ) {
              return { error: { code: "23505", message: "duplicate pending draft" } };
            }
            drafts().push({ id: `draft-${drafts().length + 1}`, ...row });
            return { error: null };
          },
        };
        return q;
      }
      throw new Error(`Unexpected table: ${table}`);
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "fn_reserve_ai_send") {
        state.reserveCalls = (state.reserveCalls ?? 0) + 1;
        if (state.reserveRpcError) {
          return Promise.resolve({ data: null, error: { message: "reserve boom" } });
        }
        const reservations = (state.sendReservations ??= new Map());
        const key = String(args.p_conversation_id);
        const existing = reservations.get(key);
        if (existing && existing.expiresAt > Date.now()) {
          return Promise.resolve({ data: false, error: null });
        }
        reservations.set(key, {
          holder: String(args.p_holder),
          expiresAt: Date.now() + Number(args.p_lease_seconds) * 1000,
        });
        state.onReserved?.();
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "fn_renew_ai_send") {
        if (state.renewError) return Promise.resolve({ data: null, error: { message: "renew boom" } });
        const reservations = (state.sendReservations ??= new Map());
        const existing = reservations.get(String(args.p_conversation_id));
        if (state.renewLost || !existing || existing.holder !== args.p_holder || existing.expiresAt <= Date.now()) {
          return Promise.resolve({ data: false, error: null });
        }
        existing.expiresAt = Date.now() + Number(args.p_lease_seconds) * 1000;
        return Promise.resolve({ data: true, error: null });
      }
      if (name === "ensure_sms_conversation_id") {
        if (state.ensureConversationError) return Promise.resolve({ data: null, error: { message: "ensure boom" } });
        return Promise.resolve({ data: state.threadConversationId, error: null });
      }
      if (name === "fn_release_ai_send") {
        const reservations = (state.sendReservations ??= new Map());
        const key = String(args.p_conversation_id);
        if (reservations.get(key)?.holder === args.p_holder) {
          reservations.delete(key);
          return Promise.resolve({ data: true, error: null });
        }
        return Promise.resolve({ data: false, error: null });
      }
      if (name === "fn_propose_jev_lead_decision") {
        state.jevLeadDecisionCalls.push({ rpc: name, args });
        return Promise.resolve({ data: { status: "proposed", decisionId: "decision-1" }, error: null });
      }
      if (name === "fn_auto_apply_jev_lead_decision") {
        // Root review of dbbb12e6, finding 1: the real RPC now performs
        // the property effect (nurture's outreach_dispo write / new_lead's
        // status write) atomically with the revision check and the audit
        // insert — this mock replicates that same effect so the tests'
        // state.property assertions still reflect what actually happens,
        // rather than relying on a SEPARATE qualifyProperty/
        // setOutreachDispoNurture mutation dispatch.ts no longer makes.
        state.jevLeadDecisionCalls.push({ rpc: name, args });
        const outcome = args.p_outcome as string;
        let status = "applied";
        if (outcome === "nurture") {
          if (state.property.outreach_dispo === "nurture") {
            status = "already_nurture";
          } else if (state.property.outreach_dispo !== null) {
            return Promise.resolve({ data: { status: "already_terminal" }, error: null });
          } else {
            state.property.outreach_dispo = "nurture";
          }
        } else if (outcome === "new_lead") {
          if (state.property.is_dnc_locked) {
            return Promise.resolve({ data: { status: "dnc_locked" }, error: null });
          }
          if (state.property.status !== undefined && state.property.status !== "prospect") {
            status = "already_qualified";
          } else {
            state.property.status = "new_lead";
            state.property.qualified_at = new Date().toISOString();
            state.property.qualified_by = "system:jev_auto_promote";
          }
        }
        return Promise.resolve({ data: { status, decisionId: "decision-1" }, error: null });
      }
      if (name === "fn_propose_deferred_ai_disposition_review") {
        // Root final-review P1 #1: mirrors the real RPC's contract — marks
        // needs_human_attention and creates a pending review, but never
        // touches properties.outreach_dispo. This is the RPC dispatch.ts
        // must call for a below-threshold Jev wrong_number/not_interested/
        // opted_out decision instead of fn_apply_ai_disposition_with_review.
        state.property.needs_human_attention = true;
        state.aiDispoReviews.push({
          conversationId: String(args.p_conversation_id),
          disposition: String(args.p_disposition),
          inboundMessageId: String(args.p_source_inbound_message_id),
          reason: String(args.p_ai_reason),
        });
        return Promise.resolve({
          data: { status: "proposed", reviewId: "review-jev-deferred" },
          error: null,
        });
      }
      if (name === "fn_propose_ai_dnc_suppression_review") {
        // Mirrors fn_propose_ai_dnc_suppression_review's real contract:
        // marks needs_human_attention, creates a pending review, but
        // deliberately does NOT write properties.outreach_dispo — the
        // entire point of the Option B fix this test exists to prove.
        state.property.needs_human_attention = true;
        state.aiDispoReviews.push({
          conversationId: String(args.p_conversation_id),
          disposition: "dnc",
          inboundMessageId: String(args.p_source_inbound_message_id),
          reason: String(args.p_ai_reason),
        });
        return Promise.resolve({
          data: { status: "proposed", reviewId: "review-jev-dnc" },
          error: null,
        });
      }
      if (name !== "fn_apply_ai_disposition_with_review") {
        throw new Error(`Unexpected RPC: ${name}`);
      }

      state.aiDispositionRpcCalls += 1;
      if (state.aiDispositionRpcErrorsRemaining > 0) {
        state.aiDispositionRpcErrorsRemaining -= 1;
        return Promise.resolve({
          data: null,
          error: { message: "transient disposition RPC failure" },
        });
      }

      const disposition = String(args.p_disposition);
      const inboundMessageId = String(args.p_source_inbound_message_id);
      const existingReview = state.aiDispoReviews.find(
        (row) => row.inboundMessageId === inboundMessageId,
      );
      if (existingReview) {
        return Promise.resolve({
          data: { status: "replayed", reviewId: "review-existing" },
          error: null,
        });
      }
      const current = state.property.outreach_dispo;
      const humanOwned = new Set([
        "bad_number",
        "nurture",
        "callback_requested",
        "booked_appointment",
      ]);
      const severity: Record<string, number> = {
        not_interested: 1,
        wrong_number: 2,
        opted_out: 3,
        dnc: 4,
      };
      const alreadyTerminal =
        state.property.needs_human_attention ||
        (current === disposition && state.aiDispoReviews.length === 0) ||
        (disposition !== "opted_out" &&
          disposition !== "dnc" &&
          current !== null &&
          humanOwned.has(current)) ||
        (severity[disposition] ?? 0) < (current ? (severity[current] ?? 0) : 0);

      if (alreadyTerminal) {
        return Promise.resolve({
          data: { status: "already_terminal" },
          error: null,
        });
      }

      state.property.outreach_dispo = disposition;
      state.property.needs_human_attention = false;
      state.aiDispoReviews.push({
        conversationId: String(args.p_conversation_id),
        disposition,
        inboundMessageId,
        reason: String(args.p_ai_reason),
      });
      return Promise.resolve({
        data: { status: "applied", reviewId: "review-1" },
        error: null,
      });
    },
  };
}

/**
 * Root review of dbbb12e6 (jev-root-autoapply-review.md, finding 3):
 * classifyForDispatch now verifies the current inbound message's own
 * row (identity check + context-cutoff timestamp) before evaluating —
 * these Jev-automatic-mode tests need a real matching `messages` row to
 * exist, which they didn't require before this fix.
 */
function seedInboundMessage(
  state: MockState,
  args: { id: string; body: string; propertyId?: string; contactId?: string; conversationId?: string },
): void {
  state.messages.push({
    id: args.id,
    body: args.body,
    channel: "sms",
    contact_id: args.contactId ?? CONTACT_ID,
    conversation_id: args.conversationId ?? CONVERSATION_ID,
    created_at: new Date().toISOString(),
    direction: "inbound",
    metadata: null,
    property_id: args.propertyId ?? PROPERTY_ID,
    sent_at: null,
    status: "received",
  });
}

/**
 * Mirrors the real provider boundary: sendSmsToContact awaits
 * `beforeProviderSubmit` as its last step and makes NO provider call (no
 * message row is delivered) when it refuses.
 */
async function passesProviderFence(
  state: MockState,
  input: { beforeProviderSubmit?: () => Promise<boolean> },
): Promise<{ status: "blocked_before_provider"; messageId: string; retired: boolean } | null> {
  if (input.beforeProviderSubmit && !(await input.beforeProviderSubmit())) {
    return { status: "blocked_before_provider", messageId: `aborted-${state.nextMessageId++}`, retired: true };
  }
  return null;
}

/**
 * Make one specific `messages` select (identified by its column list) fail or
 * pause. Everything else passes straight through to the mock.
 */
function interceptMessageSelect(
  supabase: ReturnType<typeof createMockSupabase>,
  columns: string,
  behavior: { error?: { message: string }; gate?: Promise<void> },
): void {
  const realFrom = supabase.from.bind(supabase);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (supabase as any).from = (table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = realFrom(table) as any;
    if (table !== "messages") return builder;
    let matched = false;
    const realSelect = builder.select.bind(builder);
    builder.select = (cols: string, options?: unknown) => {
      if (cols === columns) matched = true;
      return realSelect(cols, options);
    };
    const realMaybeSingle = builder.maybeSingle.bind(builder);
    builder.maybeSingle = async () => {
      if (matched) {
        if (behavior.gate) await behavior.gate;
        if (behavior.error) return { data: null, error: behavior.error };
      }
      return realMaybeSingle();
    };
    return builder;
  };
}

function installSendMock(state: MockState) {
  vi.mocked(sendSmsToContact).mockImplementation(async (_supabase, input) => {
    const refused = await passesProviderFence(state, input);
    if (refused) return refused;
    const messageId = `sent-${state.nextMessageId++}`;
    const timestamp = new Date().toISOString();
    state.messages.push({
      id: messageId,
      body: input.body,
      channel: "sms",
      contact_id: input.contactId,
      conversation_id: state.threadConversationId,
      created_at: timestamp,
      direction: "outbound",
      metadata:
        input.metadata &&
        typeof input.metadata === "object" &&
        !Array.isArray(input.metadata)
          ? (input.metadata as Record<string, unknown>)
          : null,
      property_id: input.propertyId,
      sent_at: timestamp,
      status: "sent",
    });
    return {
      externalId: `ext-${messageId}`,
      messageId,
      status: "sent",
    } as const;
  });
}

describe("dispatchAiResponse debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T18:00:00.000Z"));

    vi.mocked(getConsentState).mockResolvedValue({} as never);
    vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
    vi.mocked(applyPhoneLevelOptOut).mockResolvedValue(undefined);
    vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
    vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
    vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("sends once, then flags a second inbound that arrived before that reply went out (rule 3)", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);

    // The seller's second text arrived BEFORE the first reply went out, so
    // that reply answers a different inbound and went out since this one: a
    // human is flagged (rule 3), nothing more is generated or sent.
    const first = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Still interested?",
        inboundMessageId: "inbound-1",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    seedInboundMessage(state, { id: "inbound-2", body: "Still interested?" });
    state.messages.find((m) => m.id === "inbound-2")!.created_at = "2026-06-13T17:59:59.000Z";

    const second = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Still interested?",
        inboundMessageId: "inbound-2",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(first.outcome).toBe("sent");
    // The early gate sees the first reply (went out since this inbound) as rule 3.
    expect(second).toEqual({
      outcome: "skipped",
      reason: "superseded_before_send",
    });
    expect(state.property.needs_human_attention).toBe(true);
    expect(vi.mocked(generateAiReply)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
  });

  it("allows only one concurrent handler to claim the same inbound before sending", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const [first, second] = await Promise.all([
      dispatchAiResponse(
        supabase as never,
        {
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
          inboundBody: "Still interested?",
          inboundMessageId: "inbound-race",
          propertyId: PROPERTY_ID,
        },
        { anthropic: {} as never },
      ),
      dispatchAiResponse(
        supabase as never,
        {
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
          inboundBody: "Still interested?",
          inboundMessageId: "inbound-race",
          propertyId: PROPERTY_ID,
        },
        { anthropic: {} as never },
      ),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(["sent", "skipped"]);
    expect(vi.mocked(generateAiReply)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
  });

  it("fails closed before generation or send when the AI claim cannot be stored", async () => {
    const state = createMockState();
    state.aiClaimInsertError = true;
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Still interested?",
        inboundMessageId: "inbound-claim-error",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "already_claimed",
    });
    expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("answers identity questions with the fixed Mel with BMH copy without calling Claude", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Who is this?",
        inboundMessageId: "inbound-identity",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "sent",
      messageId: "sent-1",
      confidence: 1,
    });
    expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    expect(vi.mocked(humanizeReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        body: IDENTITY_REPLY_BODY,
      }),
    );
    expect(state.messages[0].metadata).toMatchObject({
      generated_by: "ai_responder_v1",
      inbound_message_id: "inbound-identity",
      confidence: 1,
      sentiment: "neutral",
      turn: 1,
    });
  });

  it("allows a second inbound after the 45-second window expires", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const first = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Checking in",
        inboundMessageId: "inbound-1",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    vi.advanceTimersByTime(46_000);

    const second = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Checking in",
        inboundMessageId: "inbound-2",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(first.outcome).toBe("sent");
    expect(second.outcome).toBe("sent");
    expect(vi.mocked(generateAiReply)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(2);
  });

  it("skips before generation when the property is already human-claimed", async () => {
    const state = createMockState();
    state.property.needs_human_attention = true;
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "Still interested?",
        inboundMessageId: "inbound-claimed",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "already_terminal",
    });
    expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("skips before generation when the property already has a terminal disposition", async () => {
    const state = createMockState();
    state.property.outreach_dispo = "dnc";
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "hello?",
        inboundMessageId: "inbound-terminal",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "already_terminal",
    });
    expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("skips before generation when a human already booked the appointment", async () => {
    const state = createMockState();
    state.property.outreach_dispo = "booked_appointment";
    const supabase = createMockSupabase(state);
    installSendMock(state);

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "hello?",
        inboundMessageId: "inbound-booked",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "already_terminal",
    });
    expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("treats a blocked_automated_suppressed send outcome as already_terminal — booking landed between the early gate and the provider call", async () => {
    // Property is NOT booked at gate-check time, so the early
    // isTerminalAiResponderProperty gate passes and generation runs.
    // send.ts's own fresh re-check (immediately before the provider call)
    // is what catches the flip here — simulated by the mock returning
    // blocked_automated_suppressed instead of sent.
    const state = createMockState();
    const supabase = createMockSupabase(state);
    vi.mocked(sendSmsToContact).mockResolvedValue({
      status: "blocked_automated_suppressed",
      messageId: "msg-race-1",
      reason:
        "Property has a human-owned disposition: booked_appointment. Automated sends are suppressed.",
      source: "human_owned_dispo",
      outreachDispo: "booked_appointment",
      consentState: null,
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "hello?",
        inboundMessageId: "inbound-race-booking",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "already_terminal",
    });
    expect(vi.mocked(generateAiReply)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ origin: "automated" }),
    );
  });

  it("low-confidence terminal model actions still close without sending", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_wrong_number",
      wrong_scope: "this_property",
      confidence: 0.4,
      sentiment: "neutral",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "maybe wrong house",
        inboundMessageId: "inbound-low-confidence",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "auto_closed",
      reason: "model:wrong_number",
    });
    expect(state.property.outreach_dispo).toBe("wrong_number");
    expect(state.property.needs_human_attention).toBe(false);
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.aiDispoReviews).toEqual([
      {
        conversationId: CONVERSATION_ID,
        disposition: "wrong_number",
        inboundMessageId: "inbound-low-confidence",
        reason: "model:wrong_number",
      },
    ]);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("fails closed to human attention when an AI disposition lacks exact inbound identity", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_wrong_number",
      wrong_scope: "this_property",
      confidence: 0.9,
      sentiment: "neutral",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "wrong number",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "disposition_write_failed",
    });
    expect(state.property.outreach_dispo).toBeNull();
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.aiDispoReviews).toEqual([]);
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("retries one transient disposition RPC failure and creates exactly one review", async () => {
    const state = createMockState();
    state.aiDispositionRpcErrorsRemaining = 1;
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_not_interested",
      confidence: 0.9,
      sentiment: "neutral",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "not interested",
        inboundMessageId: "inbound-transient-dispo",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "auto_closed",
      reason: "model:not_interested",
    });
    expect(state.aiDispositionRpcCalls).toBe(2);
    expect(state.aiDispoReviews).toHaveLength(1);
    expect(state.aiClaims[0]).toMatchObject({ status: "completed" });
  });

  it("leaves a persistent disposition failure visible and retryable", async () => {
    const state = createMockState();
    state.aiDispositionRpcErrorsRemaining = 2;
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_not_interested",
      confidence: 0.9,
      sentiment: "neutral",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "not interested",
        inboundMessageId: "inbound-persistent-dispo",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "disposition_write_failed",
    });
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.aiDispoReviews).toEqual([]);
    expect(state.aiClaims[0]).toMatchObject({
      error_message: "disposition_write_failed",
      status: "error",
    });
  });

  it("keeps opt-out suppression while surfacing a persistent review-write failure", async () => {
    const state = createMockState();
    state.aiDispositionRpcErrorsRemaining = 2;
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "opt_out",
      confidence: 0.9,
      sentiment: "frustrated",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "stop texting me",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-persistent-opt-out",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(vi.mocked(applyPhoneLevelOptOut)).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "disposition_write_failed",
    });
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.aiClaims[0]).toMatchObject({ status: "error" });
  });

  it("keeps DNC suppression while surfacing a persistent review-write failure", async () => {
    const state = createMockState();
    state.aiDispositionRpcErrorsRemaining = 2;
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_dnc",
      confidence: 0.9,
      sentiment: "hostile",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "do not contact me",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-persistent-dnc",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(vi.mocked(applyPhoneLevelOptOut)).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({
      outcome: "escalated",
      reason: "disposition_write_failed",
    });
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.aiClaims[0]).toMatchObject({ status: "error" });
  });

  it("does not apply drifted wrong-number side effects when a retry preserved not-interested", async () => {
    const state = createMockState();
    state.property.outreach_dispo = "not_interested";
    state.aiDispoReviews.push({
      conversationId: CONVERSATION_ID,
      disposition: "not_interested",
      inboundMessageId: "inbound-drifted-retry",
      reason: "model:not_interested",
    });
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_wrong_number",
      wrong_scope: "all",
      confidence: 0.9,
      sentiment: "neutral",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "wrong number",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-drifted-retry",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "replayed_other_disposition",
    });
    expect(state.property.outreach_dispo).toBe("not_interested");
    expect(state.aiDispositionRpcCalls).toBe(0);
    expect(vi.mocked(applyPhoneLevelOptOut)).not.toHaveBeenCalled();
    expect(state.aiClaims[0]).toMatchObject({ status: "completed" });
  });

  it("still suppresses opt-out when a retry preserves an earlier not-interested review", async () => {
    const state = createMockState();
    state.property.outreach_dispo = "not_interested";
    state.aiDispoReviews.push({
      conversationId: CONVERSATION_ID,
      disposition: "not_interested",
      inboundMessageId: "inbound-drifted-opt-out",
      reason: "model:not_interested",
    });
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "opt_out",
      confidence: 0.9,
      sentiment: "frustrated",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "stop texting me",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-drifted-opt-out",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "replayed_other_disposition",
    });
    expect(state.property.outreach_dispo).toBe("not_interested");
    expect(vi.mocked(applyPhoneLevelOptOut)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ source: "ai_responder", surface: "stop" }),
    );
    expect(state.aiDispositionRpcCalls).toBe(1);
  });

  it("still suppresses DNC when a retry preserves an earlier not-interested review", async () => {
    const state = createMockState();
    state.property.outreach_dispo = "not_interested";
    state.aiDispoReviews.push({
      conversationId: CONVERSATION_ID,
      disposition: "not_interested",
      inboundMessageId: "inbound-drifted-dnc",
      reason: "model:not_interested",
    });
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_dnc",
      confidence: 0.9,
      sentiment: "hostile",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "do not contact me",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-drifted-dnc",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "skipped",
      reason: "replayed_other_disposition",
    });
    expect(state.property.outreach_dispo).toBe("not_interested");
    expect(vi.mocked(applyPhoneLevelOptOut)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        source: "ai_responder_threat",
        surface: "dnc",
      }),
    );
    expect(state.aiDispositionRpcCalls).toBe(1);
  });

  it("low-confidence opt_out still suppresses the phone and marks the property opted out", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "opt_out",
      confidence: 0.4,
      sentiment: "frustrated",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "please delete my number",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-low-confidence-opt-out",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "opted_out",
      reason: "model:opt_out",
    });
    expect(vi.mocked(applyPhoneLevelOptOut)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        contactId: CONTACT_ID,
        fromPhone: "+18165550001",
        source: "ai_responder",
        surface: "stop",
      }),
    );
    expect(state.property.outreach_dispo).toBe("opted_out");
    expect(state.property.needs_human_attention).toBe(false);
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.aiDispoReviews).toEqual([
      {
        conversationId: CONVERSATION_ID,
        disposition: "opted_out",
        inboundMessageId: "inbound-low-confidence-opt-out",
        reason: "model:opt_out",
      },
    ]);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("close_dnc writes a suppressed DNC disposition and does not send", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "close_dnc",
      confidence: 0.9,
      sentiment: "hostile",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "I will find you and make you pay",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-threat",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "auto_closed",
      reason: "model:threat_dnc",
    });
    expect(vi.mocked(applyPhoneLevelOptOut)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        contactId: CONTACT_ID,
        fromPhone: "+18165550001",
        source: "ai_responder_threat",
        surface: "dnc",
      }),
    );
    expect(state.property.outreach_dispo).toBe("dnc");
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.aiDispoReviews).toEqual([
      {
        conversationId: CONVERSATION_ID,
        disposition: "dnc",
        inboundMessageId: "inbound-threat",
        reason: "model:threat_dnc",
      },
    ]);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("promotes a Jev new lead through qualifyProperty when at/above the org's configured threshold", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    state.jevOutcomeThresholds = [{ outcome: "new_lead", min_confidence: 0.9, version: 4 }];
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-new-lead-promoted", body: "Yes let's talk tomorrow at 2pm about selling the house" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ answers: { outcome: { choice: "new_lead", confidence: 0.95 }, escalation_reason: { choice: "call_request" } } }),
    })));
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Yes let's talk tomorrow at 2pm about selling the house",
        inboundMessageId: "inbound-new-lead-promoted", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "auto_closed", reason: "model:new_lead_promoted" });
      // The actual sanctioned promotion primitive, never a raw status write
      // and never appointment booking.
      expect(state.property.status).toBe("new_lead");
      expect(state.property.qualified_by).toBe("system:jev_auto_promote");
      expect(state.property.needs_human_attention).toBe(false);
      expect(generateAiReply).not.toHaveBeenCalled();
      expect(sendSmsToContact).not.toHaveBeenCalled();
      // Recorded in the Review Jev audit trail as an already-applied
      // (system, no human) decision — not just the promotion itself.
      // Root final-review P2: the threshold settings row's own version is
      // recorded, not just the numeric cutoff.
      expect(state.jevLeadDecisionCalls).toEqual([
        expect.objectContaining({
          rpc: "fn_auto_apply_jev_lead_decision",
          args: expect.objectContaining({ p_outcome: "new_lead", p_native_confidence: 0.95, p_threshold_version: 4 }),
        }),
      ]);
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("never calls the promotion RPC for a 1.0-confidence new_lead when automation is disabled (Phase 0 preserves human escalation)", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    state.jevOutcomeThresholds = [{ outcome: "new_lead", min_confidence: 0.9, automation_enabled: false }];
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-new-lead-held", body: "Yes let's talk tomorrow about selling" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ answers: { outcome: { choice: "new_lead", confidence: 1 }, escalation_reason: { choice: "call_request" } } }),
    })));
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Yes let's talk tomorrow about selling",
        inboundMessageId: "inbound-new-lead-held", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "escalated", reason: "model:call_request" });
      expect(state.property.status).toBe("prospect");
      expect(state.property.needs_human_attention).toBe(true);
      expect(state.jevLeadDecisionCalls.map((c) => c.rpc)).not.toContain("fn_auto_apply_jev_lead_decision");
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("does not promote and instead flags for a human when a Jev new lead is below its configured threshold", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    state.jevOutcomeThresholds = [{ outcome: "new_lead", min_confidence: 0.9 }];
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-new-lead-below-threshold", body: "Maybe call me sometime to talk about it" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ answers: { outcome: { choice: "new_lead", confidence: 0.6 }, escalation_reason: { choice: "call_request" } } }),
    })));
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Maybe call me sometime to talk about it",
        inboundMessageId: "inbound-new-lead-below-threshold", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "escalated", reason: "model:call_request" });
      expect(state.property.status).toBe("prospect");
      expect(state.property.needs_human_attention).toBe(true);
      expect(generateAiReply).not.toHaveBeenCalled();
      expect(sendSmsToContact).not.toHaveBeenCalled();
      // Below-threshold new_lead gets a real Needs-a-decision queue row,
      // not just the generic attention flag.
      expect(state.jevLeadDecisionCalls).toEqual([
        expect.objectContaining({
          rpc: "fn_propose_jev_lead_decision",
          args: expect.objectContaining({ p_outcome: "new_lead", p_native_confidence: 0.6 }),
        }),
      ]);
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it.each(["max_turns_reached", "outside_business_hours"] as const)(
    "still classifies and applies a Jev decision when reply-ineligible for reply-pacing reasons (%s)",
    async (skipReason) => {
      const state = createMockState();
      state.config.classifier_provider = "jev";
      state.config.classifier_mode = "automatic";
      state.jevOutcomeThresholds = [{ outcome: "not_interested", min_confidence: 0.95 }];
      const supabase = createMockSupabase(state);
      installSendMock(state);
      seedInboundMessage(state, { id: `inbound-decoupled-${skipReason}`, body: "Not interested, please stop" });
      vi.mocked(classifyAiSkip).mockReturnValue({ skip: true, reason: skipReason });
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ answers: { outcome: { choice: "not_interested", confidence: 0.97 } } }),
      })));
      try {
        const result = await dispatchAiResponse(supabase as never, {
          contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
          inboundBody: "Not interested, please stop",
          inboundMessageId: `inbound-decoupled-${skipReason}`, propertyId: PROPERTY_ID,
        }, { anthropic: {} as never });
        // Jev's own decision still applies — never a reply, so
        // reply-pacing ineligibility does not block it.
        expect(result.outcome).not.toBe("skipped");
        expect(state.property.outreach_dispo).toBe("not_interested");
        expect(generateAiReply).not.toHaveBeenCalled();
        expect(sendSmsToContact).not.toHaveBeenCalled();
      } finally { vi.stubGlobal("fetch", originalFetch); }
    },
  );

  describe("Jev below-threshold wrong_number/not_interested/opted_out — root final-review P1 #1", () => {
    it.each([
      { choice: "opted_out", expectedDispo: "opted_out" },
      { choice: "not_interested", expectedDispo: "not_interested" },
      { choice: "wrong_number", expectedDispo: "wrong_number" },
    ] as const)(
      "leaves properties.outreach_dispo UNCHANGED and creates only a pending review for a below-threshold Jev $choice decision",
      async ({ choice, expectedDispo }) => {
        const state = createMockState();
        state.config.classifier_provider = "jev";
        state.config.classifier_mode = "automatic";
        state.jevOutcomeThresholds = [{ outcome: choice, min_confidence: 0.95 }];
        const supabase = createMockSupabase(state);
        installSendMock(state);
        seedInboundMessage(state, { id: `inbound-below-threshold-${choice}`, body: "whatever the reply is" });
        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", vi.fn(async () => ({
          ok: true, status: 200,
          json: async () => ({ answers: { outcome: { choice, confidence: 0.5 } } }),
        })));
        try {
          const result = await dispatchAiResponse(supabase as never, {
            contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
            inboundBody: "whatever the reply is",
            inboundMessageId: `inbound-below-threshold-${choice}`, propertyId: PROPERTY_ID,
          }, { anthropic: {} as never });
          // The property's disposition state must be untouched — the
          // whole point of the fix. Merely "pending review exists" is
          // NOT sufficient proof; this asserts the actual column.
          expect(state.property.outreach_dispo).toBeNull();
          expect(state.property.needs_human_attention).toBe(true);
          expect(state.aiDispoReviews).toEqual([
            expect.objectContaining({ disposition: expectedDispo }),
          ]);
          // Below threshold means never auto-accepted and never sent —
          // held for a human either way.
          expect(result.outcome).not.toBe("sent");
          expect(generateAiReply).not.toHaveBeenCalled();
          expect(sendSmsToContact).not.toHaveBeenCalled();
          // opted_out suppresses the phone immediately at ANY confidence
          // (only the disposition write is deferred); the other two
          // below-threshold choices have no suppression side effect.
          if (choice === "opted_out") {
            expect(applyPhoneLevelOptOut).toHaveBeenCalledTimes(1);
            expect(applyPhoneLevelOptOut).toHaveBeenCalledWith(
              expect.anything(),
              expect.objectContaining({ surface: "stop", source: "ai_responder", contactId: CONTACT_ID }),
            );
          } else {
            expect(applyPhoneLevelOptOut).not.toHaveBeenCalled();
          }
        } finally { vi.stubGlobal("fetch", originalFetch); }
      },
    );

    it("applies wrong_number/not_interested/opted_out immediately (unchanged legacy behavior) when AT/ABOVE the org's configured threshold", async () => {
      const state = createMockState();
      state.config.classifier_provider = "jev";
      state.config.classifier_mode = "automatic";
      state.jevOutcomeThresholds = [{ outcome: "opted_out", min_confidence: 0.5 }];
      const supabase = createMockSupabase(state);
      installSendMock(state);
      seedInboundMessage(state, { id: "inbound-above-threshold-opted-out", body: "STOP texting me" });
      const originalFetch = globalThis.fetch;
      vi.stubGlobal("fetch", vi.fn(async () => ({
        ok: true, status: 200,
        json: async () => ({ answers: { outcome: { choice: "opted_out", confidence: 0.99 } } }),
      })));
      try {
        const result = await dispatchAiResponse(supabase as never, {
          contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
          inboundBody: "STOP texting me",
          inboundMessageId: "inbound-above-threshold-opted-out", propertyId: PROPERTY_ID,
        }, { anthropic: {} as never });
        expect(result).toEqual({ outcome: "opted_out", reason: "model:opt_out" });
        expect(state.property.outreach_dispo).toBe("opted_out");
        expect(applyPhoneLevelOptOut).toHaveBeenCalledTimes(1);
      } finally { vi.stubGlobal("fetch", originalFetch); }
    });
  });

  it("does not classify (stays fully skipped) when the org's AI responder is not active, even for a jev-classifier org", async () => {
    const state = createMockState();
    state.config.active = false;
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(classifyAiSkip).mockReturnValue({ skip: true, reason: "disabled_org_wide" });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Not interested",
        inboundMessageId: "inbound-decoupled-org-disabled", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "skipped", reason: "disabled_org_wide" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("does not classify (stays fully skipped) when the property's AI responder is disabled — human takeover is respected, not just reply pacing", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    state.property.ai_responder_disabled = true;
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(classifyAiSkip).mockReturnValue({ skip: true, reason: "disabled_per_property" });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Not interested",
        inboundMessageId: "inbound-decoupled-property-disabled", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "skipped", reason: "disabled_per_property" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("does not classify (stays fully skipped) when the contact has opted out — suppression is respected, not just reply pacing", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(getConsentState).mockResolvedValue("opted_out" as never);
    vi.mocked(classifyAiSkip).mockReturnValue({ skip: true, reason: "no_consent" });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Not interested",
        inboundMessageId: "inbound-decoupled-opted-out", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "skipped", reason: "no_consent" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("applies Jev nurture when at/above the org's configured threshold", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    state.jevOutcomeThresholds = [{ outcome: "nurture", min_confidence: 0.95 }];
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-nurture-above", body: "Not right now, maybe check back later" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ answers: { outcome: { choice: "nurture", confidence: 0.97 } } }),
    })));
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Not right now, maybe check back later",
        inboundMessageId: "inbound-nurture-above", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "auto_closed", reason: "model:nurture" });
      expect(state.property.outreach_dispo).toBe("nurture");
      expect(state.property.needs_human_attention).toBe(false);
      expect(generateAiReply).not.toHaveBeenCalled();
      expect(state.jevLeadDecisionCalls).toEqual([
        expect.objectContaining({
          rpc: "fn_auto_apply_jev_lead_decision",
          args: expect.objectContaining({ p_outcome: "nurture", p_native_confidence: 0.97 }),
        }),
      ]);
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("does not apply Jev nurture and instead flags for a human when below the org's configured threshold", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    state.jevOutcomeThresholds = [{ outcome: "nurture", min_confidence: 0.95 }];
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-nurture-below", body: "Not right now" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ answers: { outcome: { choice: "nurture", confidence: 0.6 } } }),
    })));
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Not right now",
        inboundMessageId: "inbound-nurture-below", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "escalated", reason: "jev_below_threshold:nurture" });
      expect(state.property.outreach_dispo).toBeNull();
      expect(state.property.needs_human_attention).toBe(true);
      expect(generateAiReply).not.toHaveBeenCalled();
      expect(state.jevLeadDecisionCalls).toEqual([
        expect.objectContaining({
          rpc: "fn_propose_jev_lead_decision",
          args: expect.objectContaining({ p_outcome: "nurture", p_native_confidence: 0.6 }),
        }),
      ]);
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("routes a Jev new lead to attention without nurture, reply, or booking", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-new-lead", body: "Call me tomorrow afternoon to discuss selling" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ answers: { outcome: { choice: "new_lead", confidence: 0.99 }, escalation_reason: { choice: "call_request" } } }),
    })));
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Call me tomorrow afternoon to discuss selling",
        inboundMessageId: "inbound-new-lead", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "escalated", reason: "model:call_request" });
      expect(state.property.needs_human_attention).toBe(true);
      expect(state.property.outreach_dispo).toBeNull();
      expect(state.aiDispoReviews).toEqual([]);
      expect(generateAiReply).not.toHaveBeenCalled();
      expect(sendSmsToContact).not.toHaveBeenCalled();
      // No threshold configured at all still gets a real queue row (not
      // silently defaulted to auto-apply, not silently dropped either).
      expect(state.jevLeadDecisionCalls).toEqual([
        expect.objectContaining({
          rpc: "fn_propose_jev_lead_decision",
          args: expect.objectContaining({ p_outcome: "new_lead", p_native_confidence: 0.99 }),
        }),
      ]);
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("jev-driven close_dnc suppresses immediately but defers the outreach_dispo write to human confirmation", async () => {
    // Regression test for Astra's BLOCKING PR-review finding (2026-09-20,
    // "Option B" resolution): DNC's suppression effect must happen right
    // away (halting it would mean continuing to text someone who just
    // invoked DNC/legal language), but properties.outreach_dispo must NOT
    // be written until a human confirms via fn_confirm_ai_disposition_review.
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-jev-dnc", body: "I will sue you, stop contacting me" });

    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ answers: { outcome: { choice: "dnc" } } }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const outcome = await dispatchAiResponse(
        supabase as never,
        {
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
          inboundBody: "I will sue you, stop contacting me",
          inboundFromPhone: "+18165550001",
          inboundMessageId: "inbound-jev-dnc",
          propertyId: PROPERTY_ID,
        },
        { anthropic: {} as never },
      );

      // Jev decided the action entirely — legacy Claude must never be
      // called for this message (Jarrad's explicit "no legacy call for
      // automatic-mode orgs" override).
      expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();

      // Suppression happens immediately, same as legacy dnc.
      expect(vi.mocked(applyPhoneLevelOptOut)).toHaveBeenCalledWith(
        supabase,
        expect.objectContaining({
          contactId: CONTACT_ID,
          fromPhone: "+18165550001",
          surface: "dnc",
        }),
      );

      // The entire point of the fix: outreach_dispo is NOT written yet.
      expect(state.property.outreach_dispo).toBeNull();
      expect(state.property.needs_human_attention).toBe(true);
      expect(state.aiDispoReviews).toEqual([
        {
          conversationId: CONVERSATION_ID,
          disposition: "dnc",
          inboundMessageId: "inbound-jev-dnc",
          reason: "model:threat_dnc",
        },
      ]);
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
      expect(outcome.outcome).not.toBe("sent");
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });

  // Root review of dbbb12e6 (jev-root-autoapply-review.md, finding 1):
  // dispatch coverage for the atomic RPC's non-success statuses — must
  // escalate cleanly, never silently report auto_closed with no real
  // effect and no audit row.
  it("escalates (does not auto_close) when the atomic new_lead apply reports dnc_locked", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    state.property.is_dnc_locked = true;
    state.jevOutcomeThresholds = [{ outcome: "new_lead", min_confidence: 0.9 }];
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-new-lead-dnc-locked", body: "Yes let's talk" });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ answers: { outcome: { choice: "new_lead", confidence: 0.99 }, escalation_reason: { choice: "call_request" } } }),
    })));
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Yes let's talk",
        inboundMessageId: "inbound-new-lead-dnc-locked", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "escalated", reason: "jev_new_lead_promotion_failed" });
      expect(state.property.status).not.toBe("new_lead");
      expect(state.property.needs_human_attention).toBe(true);
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("escalates with a distinct reason (does not auto_close) when the atomic nurture apply reports stale_decision_context", async () => {
    const state = createMockState();
    state.config.classifier_provider = "jev";
    state.config.classifier_mode = "automatic";
    state.jevOutcomeThresholds = [{ outcome: "nurture", min_confidence: 0.95 }];
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-nurture-stale", body: "Not right now" });
    // Simulate the RPC's own STALE_DECISION_CONTEXT rejection directly —
    // proves dispatch.ts's error-message branch (not just the happy-path
    // status field), matching how the real Postgres error surfaces.
    const originalRpc = supabase.rpc.bind(supabase);
    vi.spyOn(supabase, "rpc").mockImplementation((name: string, args: Record<string, unknown>) => {
      if (name === "fn_auto_apply_jev_lead_decision") {
        return Promise.resolve({ data: null, error: { message: "STALE_DECISION_CONTEXT" } }) as never;
      }
      return originalRpc(name, args as never) as never;
    });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ answers: { outcome: { choice: "nurture", confidence: 0.99 } } }),
    })));
    try {
      const result = await dispatchAiResponse(supabase as never, {
        contactId: CONTACT_ID, conversationId: CONVERSATION_ID,
        inboundBody: "Not right now",
        inboundMessageId: "inbound-nurture-stale", propertyId: PROPERTY_ID,
      }, { anthropic: {} as never });
      expect(result).toEqual({ outcome: "escalated", reason: "jev_stale_decision_context" });
      expect(state.property.outreach_dispo).toBeNull();
      expect(state.property.needs_human_attention).toBe(true);
    } finally { vi.stubGlobal("fetch", originalFetch); }
  });

  it("deescalate_close sends the fixed named template without humanizer", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockResolvedValueOnce({
      action: "deescalate_close",
      body: "model draft should be ignored",
      confidence: 0.9,
      sentiment: "frustrated",
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "ugh is this a scam",
        inboundMessageId: "inbound-deescalate",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({
      outcome: "auto_closed",
      reason: "model:deescalate_close",
    });
    expect(vi.mocked(humanizeReply)).not.toHaveBeenCalled();
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({
        body: "So sorry to bug you. Sounds like you get a lot of these. Are you Sam? Just want to make sure we don't bother you again.",
      }),
    );
    expect(state.property.outreach_dispo).toBe("not_interested");
    expect(state.aiDispoReviews).toEqual([
      {
        conversationId: CONVERSATION_ID,
        disposition: "not_interested",
        inboundMessageId: "inbound-deescalate",
        reason: "model:deescalate_close",
      },
    ]);
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not clobber a human-only disposition during the final write", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockImplementationOnce(async () => {
      state.property.outreach_dispo = "nurture";
      return {
        action: "close_not_interested",
        confidence: 0.9,
        sentiment: "neutral",
      };
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "not now",
        inboundMessageId: "inbound-human-owned",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({ outcome: "skipped", reason: "already_terminal" });
    expect(state.property.outreach_dispo).toBe("nurture");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("does not clobber booked_appointment during the final write", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockImplementationOnce(async () => {
      // Simulates a race: a human books the appointment (setting the
      // human-only dispo) while the AI's own generation call is still in
      // flight — the pre-generation gate passed on the OLD dispo, so this
      // is the only place left to catch it.
      state.property.outreach_dispo = "booked_appointment";
      return {
        action: "close_not_interested",
        confidence: 0.9,
        sentiment: "neutral",
      };
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "not now",
        inboundMessageId: "inbound-booked-race",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({ outcome: "skipped", reason: "already_terminal" });
    expect(state.property.outreach_dispo).toBe("booked_appointment");
    expect(recordLeadEvent).not.toHaveBeenCalled();
  });

  it("a consent outcome (opted_out) still overwrites booked_appointment, same precedence as over nurture/callback_requested", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    vi.mocked(generateAiReply).mockImplementationOnce(async () => {
      state.property.outreach_dispo = "booked_appointment";
      return {
        action: "opt_out",
        confidence: 0.4,
        sentiment: "frustrated",
      };
    });

    const outcome = await dispatchAiResponse(
      supabase as never,
      {
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        inboundBody: "please delete my number",
        inboundFromPhone: "+18165550001",
        inboundMessageId: "inbound-booked-optout-race",
        propertyId: PROPERTY_ID,
      },
      { anthropic: {} as never },
    );

    expect(outcome).toEqual({ outcome: "opted_out", reason: "model:opt_out" });
    expect(state.property.outreach_dispo).toBe("opted_out");
  });
});

describe("send chokepoint guards (fix round 2)", () => {
  const input = (id: string, body = "Still interested?") => ({
    contactId: CONTACT_ID,
    conversationId: CONVERSATION_ID,
    inboundBody: body,
    inboundMessageId: id,
    propertyId: PROPERTY_ID,
  });

  beforeEach(() => {
    Object.assign(sendReservationTuning, { deadlineMs: 0 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T18:00:00.000Z"));
    vi.mocked(getConsentState).mockResolvedValue({} as never);
    vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
    vi.mocked(applyPhoneLevelOptOut).mockResolvedValue(undefined);
    vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
    vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
    vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
    Object.assign(sendReservationTuning, defaultReservationTuning);
  });

  it("two overlapping dispatches for two inbounds in one conversation produce exactly one send", async () => {
    vi.useRealTimers();
    Object.assign(sendReservationTuning, { deadlineMs: 2000, waitDelayMs: 2 });
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-a", body: "Hello?" });
    seedInboundMessage(state, { id: "inbound-b", body: "Anyone there?" });

    const [a, b] = await Promise.all([
      dispatchAiResponse(supabase as never, input("inbound-a", "Hello?"), { anthropic: {} as never }),
      dispatchAiResponse(supabase as never, input("inbound-b", "Anyone there?"), { anthropic: {} as never }),
    ]);

    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
    expect([a, b].filter((r) => r.outcome === "sent")).toHaveLength(1);
    expect(a).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
    // The newer inbound's own run answered, so nobody is flagged.
    expect(state.property.needs_human_attention).toBe(false);
    expect(state.sendReservations?.size).toBe(0);
  });

  it("two truly concurrent sends for the SAME inbound never both reach the provider: the loser is re-scheduled, not dropped", async () => {
    vi.useRealTimers();
    const state = createMockState();
    installSendMock(state);
    // Another sender already holds the conversation lease.
    state.sendReservations = new Map([[CONVERSATION_ID, { holder: "other", expiresAt: Date.now() + 60_000 }]]);
    seedInboundMessage(state, { id: "inbound-r", body: "Hello?" });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-r", "Hello?"), { anthropic: {} as never });
    expect(result).toEqual({
      outcome: "retry",
      reason: "send_reserved_elsewhere",
      attempt: 1,
      delaySeconds: 20,
      // The generated reply rides along so the retry re-sends it verbatim.
      reply: { body: "Hi there", confidence: 0.91, sentiment: "neutral", orgId: "org-1", kind: "send_reply" },
    });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.sendReservations.get(CONVERSATION_ID)?.holder).toBe("other");
    // Not flagged and not dead-lettered while retries remain; claim stays reclaimable.
    expect(state.property.needs_human_attention).toBe(false);
    expect(state.deadLetters ?? []).toHaveLength(0);
    expect(state.aiClaims[0]).toMatchObject({ status: "error", error_message: "retry_scheduled:send_reserved_elsewhere:1" });
    expect(new Date(state.aiClaims[0]!.lease_expires_at).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("the retry reclaims the SAME inbound's claim immediately and sends once the lease is free", async () => {
    vi.useRealTimers();
    const state = createMockState();
    installSendMock(state);
    state.sendReservations = new Map([[CONVERSATION_ID, { holder: "other", expiresAt: Date.now() + 60_000 }]]);
    seedInboundMessage(state, { id: "inbound-rr", body: "Hello?" });
    const supabase = createMockSupabase(state);
    const first = await dispatchAiResponse(supabase as never, input("inbound-rr"), { anthropic: {} as never });
    expect(first.outcome).toBe("retry");
    state.sendReservations.clear();
    const second = await dispatchAiResponse(supabase as never, { ...input("inbound-rr"), retryAttempt: 1 }, { anthropic: {} as never });
    expect(second.outcome).toBe("sent");
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
    expect(state.aiClaims[0]).toMatchObject({ status: "completed" });
  });

  it("after the LAST retry a contended send is dead-lettered and the property is flagged", async () => {
    vi.useRealTimers();
    const state = createMockState();
    installSendMock(state);
    state.sendReservations = new Map([[CONVERSATION_ID, { holder: "other", expiresAt: Date.now() + 60_000 }]]);
    seedInboundMessage(state, { id: "inbound-last", body: "Hello?" });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, { ...input("inbound-last"), retryAttempt: 3 }, { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "send_reserved_elsewhere" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:send_reserved_elsewhere");
    expect(state.deadLetters).toEqual([
      expect.objectContaining({ org_id: "org-1", property_id: PROPERTY_ID, inbound_message_id: "inbound-last", body: "Hi there", reason: "send_reserved_elsewhere" }),
    ]);
    expect(state.aiClaims[0]).toMatchObject({ status: "completed" });
  });

  it("waits for a lease that frees within the wall-clock deadline (no attempt counting)", async () => {
    vi.useRealTimers();
    Object.assign(sendReservationTuning, { deadlineMs: 500, waitDelayMs: 5 });
    const state = createMockState();
    installSendMock(state);
    state.sendReservations = new Map([[CONVERSATION_ID, { holder: "other", expiresAt: Date.now() + 40 }]]);
    seedInboundMessage(state, { id: "inbound-wait", body: "Hello?" });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-wait"), { anthropic: {} as never });
    expect(result.outcome).toBe("sent");
  });

  it("a run WITHOUT a conversation id serialises against the thread's lease (same resolver, not the contact id)", async () => {
    vi.useRealTimers();
    const state = createMockState();
    installSendMock(state);
    state.sendReservations = new Map([[CONVERSATION_ID, { holder: "other", expiresAt: Date.now() + 60_000 }]]);
    seedInboundMessage(state, { id: "inbound-nc", body: "Hello?" });
    const { conversationId: _omit, ...noConversation } = input("inbound-nc");
    void _omit;
    const result = await dispatchAiResponse(createMockSupabase(state) as never, noConversation, { anthropic: {} as never });
    expect(result).toMatchObject({ outcome: "retry", reason: "send_reserved_elsewhere" });
    expect(state.reserveCalls).toBeGreaterThan(0);
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("a lease lost before the provider call (renew fails) is retried, never sent", async () => {
    const state = createMockState();
    installSendMock(state);
    state.renewLost = true;
    seedInboundMessage(state, { id: "inbound-lost", body: "Hello?" });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-lost"), { anthropic: {} as never });
    expect(result).toMatchObject({ outcome: "retry", reason: "send_lease_lost", attempt: 1, delaySeconds: 20 });
    // The fence refused at the provider boundary: the (mocked) provider submit
    // was never reached, and the lease was released.
    expect(state.messages.filter((m) => m.direction === "outbound")).toHaveLength(0);
    expect(state.sendReservations?.size).toBe(0);
  });

  it("renews the lease right before the provider call", async () => {
    const state = createMockState();
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-renew", body: "Hello?" });
    const holderExpiry: number[] = [];
    state.onReserved = () => {
      holderExpiry.push([...(state.sendReservations?.values() ?? [])][0]?.expiresAt ?? 0);
      vi.setSystemTime(new Date(Date.now() + 10_000)); // time passes before the provider boundary
    };
    vi.mocked(sendSmsToContact).mockImplementationOnce(async (_s, input) => {
      // The renewal happens in the provider fence, the last step before submit.
      await input.beforeProviderSubmit?.();
      holderExpiry.push([...(state.sendReservations?.values() ?? [])][0]?.expiresAt ?? 0);
      return { externalId: "e", messageId: "m1", status: "sent" } as never;
    });
    vi.setSystemTime(new Date("2026-06-13T18:00:00.000Z"));
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-renew"), { anthropic: {} as never });
    expect(result.outcome).toBe("sent");
    expect(holderExpiry).toHaveLength(2);
    expect(holderExpiry[1]).toBeGreaterThan(holderExpiry[0]!);
  });

  it("a provider call that outlives its timeout is a failed send: send_timeout, flagged, not retried, lease kept", async () => {
    vi.useRealTimers();
    Object.assign(sendReservationTuning, { providerTimeoutMs: 20 });
    const state = createMockState();
    seedInboundMessage(state, { id: "inbound-slow", body: "Hello?" });
    // The provider call starts (the fence passed) and then never returns.
    vi.mocked(sendSmsToContact).mockImplementation(async (_s, input) => {
      await input.beforeProviderSubmit?.();
      return new Promise(() => undefined);
    });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-slow"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "send_timeout" });
    expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.property.last_ai_escalation_reason).toBe("send_timeout");
    // The only durable copy of the text is dead-lettered (the send may or may
    // not have landed: a human decides).
    expect(state.deadLetters).toEqual([expect.objectContaining({ inbound_message_id: "inbound-slow", body: "Hi there", reason: "send_timeout" })]);
    // The request may still be in flight: the lease is NOT released.
    expect(state.sendReservations?.size).toBe(1);
    expect(state.aiClaims[0]).toMatchObject({ status: "completed" });
  });

  it("a provider timeout followed by a late success: dead letter gets a sent_late row and the flag reads send_timeout_then_sent", async () => {
    vi.useRealTimers();
    Object.assign(sendReservationTuning, { providerTimeoutMs: 20 });
    const state = createMockState();
    seedInboundMessage(state, { id: "inbound-late", body: "Hello?" });
    let land!: () => void;
    const landed = new Promise<void>((resolve) => { land = resolve; });
    vi.mocked(sendSmsToContact).mockImplementation(async (_s, inputArgs) => {
      await inputArgs.beforeProviderSubmit?.();
      await landed;
      const messageId = "sent-late-1";
      state.messages.push({
        id: messageId, body: inputArgs.body, channel: "sms", contact_id: inputArgs.contactId,
        conversation_id: state.threadConversationId, created_at: new Date().toISOString(), direction: "outbound",
        metadata: inputArgs.metadata as Record<string, unknown>, property_id: inputArgs.propertyId,
        sent_at: new Date().toISOString(), status: "sent",
      });
      return { externalId: "ext-late", messageId, status: "sent" } as const;
    });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-late"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "send_timeout" });
    expect(state.property.last_ai_escalation_reason).toBe("send_timeout");
    land();
    await new Promise((r) => setTimeout(r, 30));
    expect(state.property.last_ai_escalation_reason).toBe("send_timeout_then_sent");
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.deadLetters).toEqual([
      expect.objectContaining({ inbound_message_id: "inbound-late", reason: "send_timeout" }),
      expect.objectContaining({ inbound_message_id: "inbound-late", reason: "sent_late", body: "Hi there" }),
    ]);
  });

  it("the provider timeout is always capped under the send lease", async () => {
    vi.useRealTimers();
    Object.assign(sendReservationTuning, { providerTimeoutMs: 10 * 60_000 });
    const state = createMockState();
    seedInboundMessage(state, { id: "inbound-cap", body: "Hello?" });
    vi.mocked(sendSmsToContact).mockImplementation(async (_s, input) => {
      await input.beforeProviderSubmit?.();
      return new Promise(() => undefined);
    });
    const spy = vi.spyOn(globalThis, "setTimeout");
    void dispatchAiResponse(createMockSupabase(state) as never, input("inbound-cap"), { anthropic: {} as never });
    await new Promise((r) => setTimeout(r, 30));
    const delays = spy.mock.calls.map((c) => Number(c[1])).filter((n) => n >= 60_000);
    spy.mockRestore();
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThan(sendReservationTuning.leaseSeconds * 1000);
  });

  it("a newer inbound that lands AFTER the reservation is taken still blocks the send (and flags it)", async () => {
    const state = createMockState();
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-late", body: "Hello?" });
    state.onReserved = () => {
      vi.setSystemTime(new Date("2026-06-13T18:00:03.000Z"));
      seedInboundMessage(state, { id: "inbound-late-2", body: "Hello??" });
    };
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-late", "Hello?"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.sendReservations?.size).toBe(0);
  });

  it("a failed latest-inbound lookup FAILS CLOSED: no send, send_check_failed, property flagged", async () => {
    const state = createMockState();
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-x", body: "Hello?" });
    state.onReserved = () => {
      state.messageLookupError = "inbound";
    };
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-x", "Hello?"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.sendReservations?.size).toBe(0);
  });

  it("a failed outbound lookup FAILS CLOSED", async () => {
    const state = createMockState();
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-y", body: "Hello?" });
    state.onReserved = () => {
      state.messageLookupError = "outbound";
    };
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-y", "Hello?"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("a reservation RPC error fails closed", async () => {
    const state = createMockState();
    state.reserveRpcError = true;
    installSendMock(state);
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-z"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  const pushOutbound = (state: MockState, row: Partial<MessageRow> & { id: string }) => {
    state.messages.push({
      body: "x", channel: "sms", contact_id: CONTACT_ID, conversation_id: CONVERSATION_ID,
      created_at: new Date().toISOString(), direction: "outbound", metadata: null, property_id: PROPERTY_ID,
      sent_at: null, status: "sent", ...row,
    });
  };
  const landDuringGeneration = (state: MockState, row: Partial<MessageRow> & { id: string }) =>
    vi.mocked(generateAiReply).mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-06-13T18:00:02.000Z"));
      pushOutbound(state, { ...row, created_at: row.created_at ?? new Date().toISOString() });
      return HAPPY_REPLY;
    });

  it("FLAGS when a conversational outbound that does not answer this inbound landed after the claim (AI reply to a different inbound)", async () => {
    const state = createMockState();
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-o", body: "Hello?" });
    landDuringGeneration(state, { id: "ai-other", metadata: { generated_by: "ai_responder_v1", inbound_message_id: "some-other-inbound" } });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-o", "Hello?"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:outbound_since_claim");
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("already_answered: an AI reply to THIS inbound (or a human reply after it) skips silently, no flag", async () => {
    for (const row of [
      { id: "ai-same", metadata: { generated_by: "ai_responder_v1", inbound_message_id: "inbound-c" } },
      { id: "human-reply", metadata: null },
      { id: "rep-sms", metadata: { repSms: { workflow: "manager-through-mel" } } },
    ]) {
      vi.clearAllMocks();
      vi.mocked(getConsentState).mockResolvedValue({} as never);
      vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
      vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
      vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
      vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
      const state = createMockState();
      installSendMock(state);
      seedInboundMessage(state, { id: "inbound-c", body: "Hello?" });
      landDuringGeneration(state, row);
      const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-c", "Hello?"), { anthropic: {} as never });
      expect(result).toEqual({ outcome: "skipped", reason: "already_answered" });
      expect(state.property.needs_human_attention).toBe(false);
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    }
  });

  it("broadcast-only outbounds (bulk campaign, Norma pre-call, sequence tick by stamp or by step-run link) skip silently as superseded_by_broadcast", async () => {
    const cases: Array<[string, Partial<MessageRow> & { id: string }, string[]?]> = [
      ["bulk campaign", { id: "bulk", campaign_id: "campaign-1" }],
      ["norma precall", { id: "norma", metadata: { generated_by: "norma_precall", request_id: "r" } }],
      ["sequence tick stamp", { id: "tick-a", metadata: { generated_by: "sequence_tick" } }],
      ["sequence tick link", { id: "tick-b" }, ["tick-b"]],
      ["seller reminder", { id: "rem", metadata: { kind: "seller_appointment_reminder" } }],
    ];
    for (const [label, row, linked] of cases) {
      vi.clearAllMocks();
      vi.mocked(getConsentState).mockResolvedValue({} as never);
      vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
      vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
      vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
      vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
      const state = createMockState();
      state.sequenceMessageIds = linked;
      installSendMock(state);
      seedInboundMessage(state, { id: "inbound-b", body: "Hello?" });
      landDuringGeneration(state, row);
      const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-b", "Hello?"), { anthropic: {} as never });
      expect(result, label).toEqual({ outcome: "skipped", reason: "superseded_by_broadcast" });
      expect(state.property.needs_human_attention, label).toBe(false);
      expect(vi.mocked(sendSmsToContact), label).not.toHaveBeenCalled();
    }
  });

  it("a broadcast PLUS an unrelated conversational outbound still flags (conversational wins)", async () => {
    const state = createMockState();
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-m", body: "Hello?" });
    vi.mocked(generateAiReply).mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-06-13T18:00:02.000Z"));
      pushOutbound(state, { id: "bulk", campaign_id: "campaign-1" });
      pushOutbound(state, { id: "ai-other", metadata: { generated_by: "ai_responder_v1", inbound_message_id: "different" } });
      return HAPPY_REPLY;
    });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-m", "Hello?"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
    expect(state.property.needs_human_attention).toBe(true);
  });

  it("a failed sequence-link lookup fails closed (send_check_failed)", async () => {
    const state = createMockState();
    installSendMock(state);
    state.sequenceLookupError = true;
    seedInboundMessage(state, { id: "inbound-sq", body: "Hello?" });
    landDuringGeneration(state, { id: "bulk", campaign_id: "campaign-1" });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-sq", "Hello?"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
  });

  it("sends by default (preserves production today)", async () => {
    const state = createMockState();
    installSendMock(state);
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-d"), { anthropic: {} as never });
    expect(result.outcome).toBe("sent");
    expect(state.aiReplyDrafts ?? []).toHaveLength(0);
  });

  it("holds the reply as a draft when ai_responder_configs.outbound_mode is hold", async () => {
    const state = createMockState();
    state.config.outbound_mode = "hold";
    installSendMock(state);
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-e"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "draft_held" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.aiReplyDrafts).toEqual([
      expect.objectContaining({ org_id: "org-1", source: "llm", status: "pending", body: "Hi there", inbound_message_id: "inbound-e" }),
    ]);
    expect(state.property.needs_human_attention).toBe(true);
  });

  it("EITHER hold wins: env send cannot override a DB hold; env hold forces hold over a DB send", async () => {
    vi.stubEnv("AI_RESPONDER_OUTBOUND_MODE", "send");
    const held = createMockState();
    held.config.outbound_mode = "hold";
    installSendMock(held);
    const heldResult = await dispatchAiResponse(createMockSupabase(held) as never, input("inbound-f"), { anthropic: {} as never });
    expect(heldResult).toEqual({ outcome: "escalated", reason: "draft_held" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(getConsentState).mockResolvedValue({} as never);
    vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
    vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
    vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
    vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
    vi.stubEnv("AI_RESPONDER_OUTBOUND_MODE", "hold");
    const open = createMockState();
    installSendMock(open);
    const result = await dispatchAiResponse(createMockSupabase(open) as never, input("inbound-g"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "draft_held" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(getConsentState).mockResolvedValue({} as never);
    vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
    vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
    vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
    vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
    vi.stubEnv("AI_RESPONDER_OUTBOUND_MODE", "send");
    const both = createMockState();
    installSendMock(both);
    expect((await dispatchAiResponse(createMockSupabase(both) as never, input("inbound-g2"), { anthropic: {} as never })).outcome).toBe("sent");
  });

  it("re-reads the outbound mode immediately before the provider call (an owner flipping to hold mid-flight wins)", async () => {
    const state = createMockState();
    installSendMock(state);
    vi.mocked(generateAiReply).mockImplementation(async () => {
      state.config.outbound_mode = "hold"; // flipped after dispatch-start snapshot
      return HAPPY_REPLY;
    });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-live"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "draft_held" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.aiReplyDrafts).toHaveLength(1);
    expect(state.sendReservations?.size).toBe(0);
  });

  it("a failed draft write is NOT swallowed or dropped: while retries remain it is re-scheduled (no flag, no dead letter, no body in the report)", async () => {
    const state = createMockState();
    state.config.outbound_mode = "hold";
    state.draftInsertError = { message: "insert boom" };
    installSendMock(state);
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-df"), { anthropic: {} as never });
    expect(result).toMatchObject({ outcome: "retry", reason: "draft_persist_failed", attempt: 1, delaySeconds: 20 });
    expect(state.property.needs_human_attention).toBe(false);
    expect(state.deadLetters ?? []).toHaveLength(0);
    expect(state.aiClaims[0]).toMatchObject({ status: "error", error_message: "retry_scheduled:draft_persist_failed:1" });
    for (const call of reportErrorMock.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain("Hi there");
    }
  });

  it("after the LAST retry a failed draft write is dead-lettered and the property flagged draft_persist_failed", async () => {
    const state = createMockState();
    state.config.outbound_mode = "hold";
    state.draftInsertError = { message: "insert boom" };
    installSendMock(state);
    const result = await dispatchAiResponse(createMockSupabase(state) as never, { ...input("inbound-dl"), retryAttempt: 3 }, { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "draft_persist_failed" });
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.property.last_ai_escalation_reason).toBe("draft_persist_failed");
    expect(state.deadLetters).toEqual([
      expect.objectContaining({ org_id: "org-1", inbound_message_id: "inbound-dl", body: "Hi there", reason: "draft_persist_failed" }),
    ]);
    for (const call of reportErrorMock.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain("Hi there");
    }
  });

  it("when the dead letter write fails too it is retried once, flagged, and NEITHER report carries the reply text", async () => {
    const state = createMockState();
    state.config.outbound_mode = "hold";
    state.draftInsertError = { message: "insert boom" };
    state.deadLetterInsertError = { message: "dead letter boom" };
    installSendMock(state);
    const result = await dispatchAiResponse(createMockSupabase(state) as never, { ...input("inbound-dl2"), retryAttempt: 3 }, { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "draft_persist_failed" });
    expect(state.property.needs_human_attention).toBe(true);
    expect(state.deadLetterInsertAttempts).toBe(2);
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: { surface: "ai_responder_dead_letter_insert" } }),
    );
    for (const call of reportErrorMock.mock.calls) {
      expect(JSON.stringify(call[1])).not.toContain("Hi there");
    }
  });

  it("policy re-read FAILS CLOSED: a config lookup error, or no active config row, holds the reply instead of sending", async () => {
    for (const flag of ["configReadError", "configMissing"] as const) {
      vi.clearAllMocks();
      vi.mocked(getConsentState).mockResolvedValue({} as never);
      vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
      vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
      vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
      vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
      const state = createMockState();
      installSendMock(state);
      state.onReserved = () => {
        state[flag] = true;
      };
      const result = await dispatchAiResponse(createMockSupabase(state) as never, input(`inbound-${flag}`), { anthropic: {} as never });
      // Rule 0 / fail closed: the gate evaluation under the lease reads the org
      // config first. An unreadable config fails closed (send_check_failed); a
      // missing active config means the responder is off for the org, which is
      // a silent exit by design (rule 0). Either way nothing is sent.
      expect(result, flag).toEqual(
        flag === "configReadError"
          ? { outcome: "escalated", reason: "send_check_failed" }
          : { outcome: "skipped", reason: "disabled_org_wide" },
      );
      expect(vi.mocked(sendSmsToContact), flag).not.toHaveBeenCalled();
      expect(state.property.needs_human_attention, flag).toBe(flag === "configReadError");
    }
  });

  it("draft reuse: a pending draft is reused; a discarded OR sent one is never revived (silent already_answered)", async () => {
    const state = createMockState();
    state.config.outbound_mode = "hold";
    installSendMock(state);
    state.aiReplyDrafts = [{ id: "d1", inbound_message_id: "inbound-ru", status: "discarded", body: "old" }];
    const supabase = createMockSupabase(state);
    const revived = await dispatchAiResponse(supabase as never, input("inbound-ru"), { anthropic: {} as never });
    // A human discarded it: the retry must not put it back in their queue.
    expect(revived).toEqual({ outcome: "skipped", reason: "already_answered" });
    expect(state.aiReplyDrafts).toEqual([expect.objectContaining({ id: "d1", status: "discarded" })]);
    expect(state.property.needs_human_attention).toBe(false);

    const pending = createMockState();
    pending.config.outbound_mode = "hold";
    installSendMock(pending);
    pending.aiReplyDrafts = [{ id: "d3", inbound_message_id: "inbound-pd", status: "pending", body: "old" }];
    const reused = await dispatchAiResponse(createMockSupabase(pending) as never, input("inbound-pd"), { anthropic: {} as never });
    expect(reused).toEqual({ outcome: "escalated", reason: "draft_held" });
    expect(pending.aiReplyDrafts).toHaveLength(1);

    const sent = createMockState();
    sent.config.outbound_mode = "hold";
    installSendMock(sent);
    sent.aiReplyDrafts = [{ id: "d2", inbound_message_id: "inbound-sn", status: "sent", body: "old" }];
    const result = await dispatchAiResponse(createMockSupabase(sent) as never, input("inbound-sn"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "skipped", reason: "already_answered" });
    expect(sent.aiReplyDrafts).toEqual([expect.objectContaining({ id: "d2", status: "sent" })]);
    expect(sent.property.needs_human_attention).toBe(false);
  });

  it("a retry after a failed draft write persists the draft once; a duplicate pending insert is idempotent", async () => {
    const state = createMockState();
    state.config.outbound_mode = "hold";
    state.draftInsertError = { message: "insert boom" };
    installSendMock(state);
    const supabase = createMockSupabase(state);
    await dispatchAiResponse(supabase as never, input("inbound-rt"), { anthropic: {} as never });
    // Lease expires, DB recovers, ordinary retry re-runs.
    state.draftInsertError = undefined;
    state.aiClaims[0]!.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    const retry = await dispatchAiResponse(supabase as never, input("inbound-rt"), { anthropic: {} as never });
    expect(retry).toEqual({ outcome: "escalated", reason: "draft_held" });
    expect(state.aiReplyDrafts).toHaveLength(1);
    // Second run hitting the unique pending index counts as stored.
    state.property.needs_human_attention = false;
    state.aiClaims[0]!.status = "processing";
    state.aiClaims[0]!.lease_expires_at = new Date(Date.now() - 1000).toISOString();
    const again = await dispatchAiResponse(supabase as never, input("inbound-rt"), { anthropic: {} as never });
    expect(again).toEqual({ outcome: "escalated", reason: "draft_held" });
    expect(state.aiReplyDrafts).toHaveLength(1);
  });

  it("a duplicate dispatch (claim lost) marks its run context duplicate so it cannot finalise the shared run", async () => {
    const state = createMockState();
    installSendMock(state);
    state.aiClaims.push({
      id: "claim-existing",
      inbound_message_id: "inbound-dup",
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      response_kind: "sms_ai_responder_v1",
      status: "processing",
    });
    const runContext = { runId: "run-dup", orgId: "org-1", seq: 0 };
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-dup"), {
      anthropic: {} as never,
      runContext,
    });
    expect(result.outcome).toBe("skipped");
    expect(runContext).toMatchObject({ duplicate: true });
    expect(runContext).not.toHaveProperty("claimId");
  });

  it("AI_RESPONDER_LLM_AUTOSEND=0 holds llm replies (Phase-1 D5 enforcement)", async () => {
    vi.stubEnv("AI_RESPONDER_LLM_AUTOSEND", "0");
    const state = createMockState();
    installSendMock(state);
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-h"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "draft_held" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.aiReplyDrafts).toHaveLength(1);
  });
});

describe("fix round 5: retries are never silently dropped; fencing at the provider boundary", () => {
  const inp = (id: string, extra: Record<string, unknown> = {}) => ({
    contactId: CONTACT_ID,
    conversationId: CONVERSATION_ID,
    inboundBody: "Still interested?",
    inboundMessageId: id,
    propertyId: PROPERTY_ID,
    ...extra,
  });
  const CARRIED = {
    body: "Hi there",
    confidence: 0.91,
    sentiment: "neutral" as const,
    orgId: "org-1",
    kind: "send_reply" as const,
  };
  const anthropic = { anthropic: {} as never };

  beforeEach(() => {
    Object.assign(sendReservationTuning, { deadlineMs: 0 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-13T18:00:00.000Z"));
    vi.mocked(getConsentState).mockResolvedValue({} as never);
    vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
    vi.mocked(applyPhoneLevelOptOut).mockResolvedValue(undefined);
    vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
    vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
    vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.clearAllMocks();
    reportErrorMock.mockClear();
    Object.assign(sendReservationTuning, defaultReservationTuning);
  });

  const at = (hhmmss: string) => `2026-06-13T${hhmmss}.000Z`;
  const seedInboundAt = (state: MockState, id: string, iso: string, metadata: Record<string, unknown> | null = null) => {
    seedInboundMessage(state, { id, body: "Hello?" });
    const row = state.messages.find((m) => m.id === id)!;
    row.created_at = iso;
    row.metadata = metadata;
  };
  const pushOutbound = (state: MockState, row: Partial<MessageRow> & { id: string }) => {
    state.messages.push({
      body: "x", channel: "sms", contact_id: CONTACT_ID, conversation_id: CONVERSATION_ID,
      created_at: at("18:00:00"), direction: "outbound", metadata: null, property_id: PROPERTY_ID,
      sent_at: row.created_at ?? at("18:00:00"), status: "sent", ...row,
    });
  };
  const aiReplyTo = (inbound: string | undefined) => ({
    generated_by: "ai_responder_v1",
    ...(inbound ? { inbound_message_id: inbound } : {}),
  });
  const landDuringGeneration = (state: MockState, rows: Array<Partial<MessageRow> & { id: string }>) =>
    vi.mocked(generateAiReply).mockImplementation(async () => {
      vi.setSystemTime(new Date(at("18:00:02")));
      for (const row of rows) pushOutbound(state, { created_at: at("18:00:02"), ...row });
      return HAPPY_REPLY;
    });

  describe("A. a retry is never silently dropped", () => {
    it("contention -> an OLDER inbound's reply lands -> the NEWEST inbound's retry is not throttled away: it is flagged (the seller is unresolved)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-w", at("17:59:00"));
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      // The older run's reply to W landed while X waited out the contention.
      pushOutbound(state, { id: "ai-w", created_at: at("18:00:20"), metadata: aiReplyTo("inbound-w") });
      vi.setSystemTime(new Date(at("18:00:30")));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x", { retryAttempt: 1 }), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
      expect(state.property.needs_human_attention).toBe(true);
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:outbound_since_claim");
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });

    it("the same retry is a silent already_answered when the seller was in fact answered (a human text was sent after the inbound)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      pushOutbound(state, { id: "ai-w", created_at: at("18:00:20"), metadata: aiReplyTo("inbound-w") });
      pushOutbound(state, { id: "human", created_at: at("18:00:25"), status: "delivered", metadata: null });
      vi.setSystemTime(new Date(at("18:00:30")));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x", { retryAttempt: 1 }), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "already_answered" });
      expect(state.property.needs_human_attention).toBe(false);
      expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    });

    it("a FIRST dispatch still honours the 45s throttle (only retries bypass it)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-x", at("17:59:40"));
      pushOutbound(state, { id: "ai-w", created_at: at("17:59:50"), sent_at: at("17:59:50"), metadata: aiReplyTo("inbound-w") });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
      expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    });

    describe("early newer-inbound check asks whether the newer inbound is handled", () => {
      const run = async (setup: (state: MockState) => void) => {
        const state = createMockState();
        installSendMock(state);
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        seedInboundAt(state, "inbound-y", at("18:00:05"));
        setup(state);
        // The newer inbound is a minute old: past the early-gate grace window.
        vi.setSystemTime(new Date(at("18:01:00")));
        const result = await dispatchAiResponse(
          createMockSupabase(state) as never,
          inp("inbound-x"),
          { ...anthropic, checkSuperseded: true },
        );
        return { state, result };
      };
      const claim = (status: string, error_message?: string, outcome?: string) => (state: MockState) => {
        state.aiClaims.push({
          id: "claim-y",
          inbound_message_id: "inbound-y",
          response_kind: "sms_ai_responder_v1",
          status,
          lease_expires_at: at("18:05:00"),
          ...(error_message ? { error_message } : {}),
          ...(outcome ? { outcome } : {}),
        });
      };

      it("unhandled newer inbound: flagged (nobody will answer the seller)", async () => {
        const { state, result } = await run(() => undefined);
        expect(result).toEqual({ outcome: "skipped", reason: "superseded_by_newer_inbound" });
        expect(state.property.needs_human_attention).toBe(true);
        expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:newer_inbound");
      });
      it("a plain errored claim on the newer inbound is NOT handled", async () => {
        const { state } = await run(claim("error", "boom"));
        expect(state.property.needs_human_attention).toBe(true);
      });
      const WORKFLOW = { outcome: "delayed", workflowRunId: "wf_1" };
      const stampY = (st: MockState, stamp: Record<string, unknown>) => {
        st.messages.find((m) => m.id === "inbound-y")!.metadata = { processing: { aiResponder: stamp } };
      };
      it.each([
        ["a live claim", claim("processing")],
        ["a claim completed by SENDING a reply", claim("completed", undefined, "sent")],
        ["a claim completed by FLAGGING the property for a human", claim("completed", undefined, "escalated")],
        [
          "a claim parked for a CONFIRMED scheduled retry (workflow run id stamped)",
          (st: MockState) => {
            claim("error", "retry_scheduled:send_reserved_elsewhere:1")(st);
            stampY(st, WORKFLOW);
          },
        ],
      ])("%s on the newer inbound: silent skip", async (_label, setup) => {
        const { state, result } = await run(setup);
        expect(result).toEqual({ outcome: "skipped", reason: "superseded_by_newer_inbound" });
        expect(state.property.needs_human_attention).toBe(false);
      });
      it("an EXPIRED processing claim with NO confirmed delay is not a live handler: flagged", async () => {
        const { state } = await run((st) => {
          claim("processing")(st);
          st.aiClaims[0]!.lease_expires_at = at("17:59:00");
        });
        expect(state.property.needs_human_attention).toBe(true);
        expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:newer_inbound");
      });
      it("an expired processing claim WITH a confirmed reply delay (workflow id) still counts as handled", async () => {
        const { state, result } = await run((st) => {
          claim("processing")(st);
          st.aiClaims[0]!.lease_expires_at = at("17:59:00");
          stampY(st, WORKFLOW);
        });
        expect(result).toEqual({ outcome: "skipped", reason: "superseded_by_newer_inbound" });
        expect(state.property.needs_human_attention).toBe(false);
      });
      it.each(["skipped", "no_consent", "disabled_org_wide", "disabled_per_property", "retry"])(
        "a claim COMPLETED with outcome %s handled nothing: the older reply is flagged (rule 1)",
        async (outcome) => {
          const { state } = await run(claim("completed", undefined, outcome));
          expect(state.property.needs_human_attention).toBe(true);
          expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:newer_inbound");
        },
      );
      it.each(["skipped:rule_0", "skipped:rule_2", "skipped:rule_4", "skipped:rule_5", "skipped:rule_8"])(
        "a claim that ended silently (%s) on the newer inbound counts as handled: older reply skipped silently, not flagged",
        async (outcome) => {
          const { state, result } = await run(claim("completed", undefined, outcome));
          expect(result).toEqual({ outcome: "skipped", reason: "superseded_by_newer_inbound" });
          expect(state.property.needs_human_attention).toBe(false);
        },
      );
      it.each(["skipped:rule_1", "skipped:rule_3", "skipped:rule_6", "skipped:rule_7", "skipped:weird"])(
        "a skipped claim whose rule is not 0/2/4/5/8 (%s) is NOT handled: flagged",
        async (outcome) => {
          const { state } = await run(claim("completed", undefined, outcome));
          expect(state.property.needs_human_attention).toBe(true);
        },
      );
      it("a delay stamp counts only while its claim has not since finished without handling: bare skipped + stamp is flagged, skipped:rule_2 + stamp is handled", async () => {
        const bare = await run((st) => {
          claim("completed", undefined, "skipped")(st);
          stampY(st, WORKFLOW);
        });
        expect(bare.state.property.needs_human_attention).toBe(true);
        const silent = await run((st) => {
          claim("completed", undefined, "skipped:rule_2")(st);
          stampY(st, WORKFLOW);
        });
        expect(silent.state.property.needs_human_attention).toBe(false);
      });
      it("a completed skipped claim is authoritative over a stale delayed stamp", async () => {
        const { state } = await run((st) => {
          claim("completed", undefined, "skipped")(st);
          stampY(st, WORKFLOW);
        });
        expect(state.property.needs_human_attention).toBe(true);
      });
      it("a retry claim whose scheduling was never confirmed (no workflow run id) is not live: flagged", async () => {
        const { state } = await run(claim("error", "retry_scheduled:send_lease_lost:1"));
        expect(state.property.needs_human_attention).toBe(true);
      });
      it("a reply workflow stamped delayed WITH a workflow id counts as handled", async () => {
        const { state, result } = await run((st) => stampY(st, WORKFLOW));
        expect(result).toEqual({ outcome: "skipped", reason: "superseded_by_newer_inbound" });
        expect(state.property.needs_human_attention).toBe(false);
      });
      it("a delayed stamp WITHOUT a workflow id is not handled: flagged", async () => {
        const { state } = await run((st) => stampY(st, { outcome: "delayed" }));
        expect(state.property.needs_human_attention).toBe(true);
      });
    });

    it("a retry whose claim is refused is flagged claim_refused_on_retry, never a silent skip; a first dispatch is not", async () => {
      for (const retryAttempt of [1, 0]) {
        const state = createMockState();
        installSendMock(state);
        seedInboundAt(state, "inbound-c", at("18:00:00"));
        state.aiClaims.push({
          id: "claim-c",
          inbound_message_id: "inbound-c",
          response_kind: "sms_ai_responder_v1",
          status: "processing",
          lease_expires_at: at("18:05:00"),
        });
        const result = await dispatchAiResponse(
          createMockSupabase(state) as never,
          inp("inbound-c", retryAttempt ? { retryAttempt } : {}),
          anthropic,
        );
        expect(result).toEqual({ outcome: "skipped", reason: "already_claimed" });
        expect(state.property.needs_human_attention).toBe(retryAttempt > 0);
        if (retryAttempt > 0) {
          expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:claim_refused_on_retry");
        }
      }
    });

    describe("claim release at retry scheduling reports failure explicitly", () => {
      const contended = () => {
        const state = createMockState();
        installSendMock(state);
        state.sendReservations = new Map([[CONVERSATION_ID, { holder: "other", expiresAt: Date.now() + 60_000 }]]);
        seedInboundAt(state, "inbound-k", at("18:00:00"));
        return state;
      };

      it("a failed completion write falls back to the dedicated lease expiry and the retry is still scheduled", async () => {
        const state = contended();
        state.claimUpdateFailures = 1;
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-k"), anthropic);
        expect(result).toMatchObject({ outcome: "retry", reason: "send_reserved_elsewhere", attempt: 1 });
        expect(state.aiClaims[0]).toMatchObject({ status: "error", error_message: "retry_scheduled:send_reserved_elsewhere:1" });
        expect(new Date(state.aiClaims[0]!.lease_expires_at).getTime()).toBeLessThanOrEqual(Date.now());
        expect(state.property.needs_human_attention).toBe(false);
        expect(reportErrorMock).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { surface: "ai_response_claim_complete" } }));
      });

      it("when the lease cannot be expired either, NO retry is scheduled: the reply is dead-lettered and a human flagged at once", async () => {
        const state = contended();
        state.claimUpdateFailures = 99;
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-k"), anthropic);
        expect(result).toEqual({ outcome: "escalated", reason: "send_reserved_elsewhere" });
        expect(state.property.needs_human_attention).toBe(true);
        expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:send_reserved_elsewhere");
        expect(state.deadLetters).toEqual([
          expect.objectContaining({ inbound_message_id: "inbound-k", body: "Hi there", reason: "send_reserved_elsewhere" }),
        ]);
        expect(reportErrorMock).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ tags: { surface: "ai_response_claim_expire_lease" } }));
      });
    });
  });

  describe("B. the answered window and classification", () => {
    it("a human reply during the retry gap (before the retry's own claim) is already_answered: no AI send, no regeneration", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-g", at("18:00:00"));
      pushOutbound(state, { id: "human", created_at: at("18:00:10"), status: "sent", metadata: null });
      vi.setSystemTime(new Date(at("18:00:30"))); // the retry's claim starts here, after the human reply
      const result = await dispatchAiResponse(
        createMockSupabase(state) as never,
        inp("inbound-g", { retryAttempt: 1, retryReply: CARRIED }),
        anthropic,
      );
      expect(result).toEqual({ outcome: "skipped", reason: "already_answered" });
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("a QUEUED human reply does not count as answered: the AI waits (retry), and goes out once that text has failed", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-q", at("18:00:00"));
      pushOutbound(state, { id: "human-q", created_at: at("18:00:05"), status: "queued", metadata: null });
      vi.setSystemTime(new Date(at("18:00:10")));
      const supabase = createMockSupabase(state);
      const first = await dispatchAiResponse(supabase as never, inp("inbound-q"), anthropic);
      expect(first).toMatchObject({ outcome: "retry", reason: "reply_pending", attempt: 1 });
      expect(state.property.needs_human_attention).toBe(false);
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();

      // The human's text fails; the next attempt falls through to a normal send.
      state.messages.find((m) => m.id === "human-q")!.status = "failed";
      vi.setSystemTime(new Date(at("18:00:30")));
      const second = await dispatchAiResponse(
        supabase as never,
        inp("inbound-q", { retryAttempt: 1, retryReply: (first as { reply: typeof CARRIED }).reply }),
        anthropic,
      );
      expect(second.outcome).toBe("sent");
      expect(vi.mocked(sendSmsToContact)).toHaveBeenCalledTimes(1);
    });

    it("a human reply still unsent on the LAST attempt is dead-lettered and flagged (never a silent skip)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-q2", at("18:00:00"));
      pushOutbound(state, { id: "human-q", created_at: at("18:00:05"), status: "pending", metadata: null });
      vi.setSystemTime(new Date(at("18:00:10")));
      const result = await dispatchAiResponse(
        createMockSupabase(state) as never,
        inp("inbound-q2", { retryAttempt: 3, retryReply: CARRIED }),
        anthropic,
      );
      expect(result).toEqual({ outcome: "escalated", reason: "reply_pending" });
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:reply_pending");
      expect(state.deadLetters).toEqual([expect.objectContaining({ reason: "reply_pending", body: "Hi there" })]);
    });

    it("an AI outbound with NO inbound id is unrelated_ai (flag), never mistaken for a human reply", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-n", at("18:00:00"));
      landDuringGeneration(state, [{ id: "ai-noid", metadata: aiReplyTo(undefined) }]);
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-n"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:outbound_since_claim");
    });

    it("precedence: already-answered beats an unrelated AI reply (silent), and an unrelated AI reply beats a broadcast (flag)", async () => {
      const answered = createMockState();
      installSendMock(answered);
      seedInboundAt(answered, "inbound-p", at("18:00:00"));
      landDuringGeneration(answered, [
        { id: "ai-other", metadata: aiReplyTo("different") },
        { id: "human", status: "sent", metadata: null },
        { id: "bulk", campaign_id: "campaign-1" },
      ]);
      const first = await dispatchAiResponse(createMockSupabase(answered) as never, inp("inbound-p"), anthropic);
      expect(first).toEqual({ outcome: "skipped", reason: "already_answered" });
      expect(answered.property.needs_human_attention).toBe(false);

      vi.clearAllMocks();
      vi.mocked(getConsentState).mockResolvedValue({} as never);
      vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
      vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
      vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
      vi.setSystemTime(new Date(at("18:00:00")));
      const flagged = createMockState();
      installSendMock(flagged);
      seedInboundAt(flagged, "inbound-p2", at("18:00:00"));
      landDuringGeneration(flagged, [
        { id: "bulk", campaign_id: "campaign-1" },
        { id: "ai-other", metadata: aiReplyTo("different") },
      ]);
      const second = await dispatchAiResponse(createMockSupabase(flagged) as never, inp("inbound-p2"), anthropic);
      expect(second).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
      expect(flagged.property.needs_human_attention).toBe(true);
    });
  });

  describe("C. fencing at the real provider boundary", () => {
    const pausedProvider = (state: MockState) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const providerCalls: string[] = [];
      vi.mocked(sendSmsToContact).mockImplementation(async (_s, input) => {
        await gate; // a preflight await (sender lookup etc.) that is paused
        const refused = await passesProviderFence(state, input);
        if (refused) return refused;
        providerCalls.push(input.body);
        return { status: "sent", messageId: "m-late", externalId: "e-late" } as never;
      });
      return { release, providerCalls };
    };

    it("a preflight paused until ANOTHER holder owns the lease cannot submit: the fence refuses, the reply is retried", async () => {
      const state = createMockState();
      seedInboundAt(state, "inbound-f", at("18:00:00"));
      const { release, providerCalls } = pausedProvider(state);
      const pending = dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-f"), anthropic);
      await vi.advanceTimersByTimeAsync(0);
      state.sendReservations!.set(CONVERSATION_ID, { holder: "other", expiresAt: Date.now() + 60_000 });
      release();
      const result = await pending;
      expect(result).toMatchObject({ outcome: "retry", reason: "send_lease_lost", attempt: 1 });
      expect(providerCalls).toEqual([]);
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("a preflight paused past the attempt deadline is abandoned: the attempt is retried and the late completion can neither submit nor flag", async () => {
      const state = createMockState();
      seedInboundAt(state, "inbound-d", at("18:00:00"));
      const { release, providerCalls } = pausedProvider(state);
      const pending = dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-d"), anthropic);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(sendReservationTuning.providerTimeoutMs + 1_000);
      const result = await pending;
      expect(result).toMatchObject({ outcome: "retry", reason: "send_preflight_timeout", attempt: 1 });
      expect(state.sendReservations?.size).toBe(0);
      // The paused await resumes long after the lease expired.
      vi.setSystemTime(new Date(Date.now() + sendReservationTuning.leaseSeconds * 1000 + 1_000));
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(providerCalls).toEqual([]);
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("a hung RESERVE RPC is bounded by the same deadline (the attempt is retried, no provider call)", async () => {
      const state = createMockState();
      seedInboundAt(state, "inbound-h", at("18:00:00"));
      installSendMock(state);
      const supabase = createMockSupabase(state);
      const realRpc = supabase.rpc.bind(supabase);
      supabase.rpc = ((name: string, args: Record<string, unknown>) =>
        name === "fn_reserve_ai_send" ? new Promise(() => undefined) : realRpc(name, args)) as never;
      const pending = dispatchAiResponse(supabase as never, inp("inbound-h"), anthropic);
      await vi.advanceTimersByTimeAsync(sendReservationTuning.providerTimeoutMs + 1_000);
      const result = await pending;
      expect(result).toMatchObject({ outcome: "retry", reason: "send_preflight_timeout" });
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });
  });

  describe("D. reply bodies never reach logs", () => {
    it("no failure branch passes the reply text to reportError", async () => {
      const scenarios: Array<(state: MockState) => Partial<Parameters<typeof dispatchAiResponse>[1]> | void> = [
        (st) => { st.reserveRpcError = true; },
        (st) => { st.renewError = true; },
        (st) => { st.ensureConversationError = true; return { conversationId: undefined }; },
        (st) => { st.config.outbound_mode = "hold"; st.draftInsertError = { message: "insert boom" }; st.deadLetterInsertError = { message: "dl boom" }; return { retryAttempt: 3 }; },
        (st) => { st.sendReservations = new Map([[CONVERSATION_ID, { holder: "other", expiresAt: Date.now() + 60_000 }]]); st.claimUpdateFailures = 99; st.deadLetterInsertError = { message: "dl boom" }; },
        (st) => { st.messageLookupError = "outbound"; },
      ];
      for (const [index, scenario] of scenarios.entries()) {
        const state = createMockState();
        installSendMock(state);
        seedInboundAt(state, `inbound-log-${index}`, at("18:00:00"));
        const extra = scenario(state) ?? {};
        await dispatchAiResponse(createMockSupabase(state) as never, inp(`inbound-log-${index}`, extra), anthropic);
      }
      expect(reportErrorMock.mock.calls.length).toBeGreaterThan(0);
      for (const call of reportErrorMock.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("Hi there");
      }
    });
  });

  describe("E. every fail-closed path with a generated reply dead-letters it before flagging", () => {
    const expectDeadLettered = (state: MockState, reason: string, inbound: string) => {
      expect(state.deadLetters).toEqual([expect.objectContaining({ inbound_message_id: inbound, body: "Hi there", reason })]);
      expect(state.property.needs_human_attention).toBe(true);
      expect(state.property.last_ai_escalation_reason).toBe(reason);
    };

    it("reservation key cannot be resolved", async () => {
      const state = createMockState();
      state.ensureConversationError = true;
      installSendMock(state);
      seedInboundAt(state, "inbound-e1", at("18:00:00"));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-e1", { conversationId: undefined }), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
      expectDeadLettered(state, "send_check_failed", "inbound-e1");
    });

    it("reservation RPC error", async () => {
      const state = createMockState();
      state.reserveRpcError = true;
      installSendMock(state);
      seedInboundAt(state, "inbound-e2", at("18:00:00"));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-e2"), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
      expectDeadLettered(state, "send_check_failed", "inbound-e2");
    });

    it("renew error at the provider fence", async () => {
      const state = createMockState();
      state.renewError = true;
      installSendMock(state);
      seedInboundAt(state, "inbound-e3", at("18:00:00"));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-e3"), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
      expectDeadLettered(state, "send_check_failed", "inbound-e3");
      expect(state.messages.filter((m) => m.direction === "outbound")).toHaveLength(0);
    });

    it("a pre-send lookup that cannot be trusted", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-e4", at("18:00:00"));
      state.onReserved = () => {
        state.messageLookupError = "outbound";
      };
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-e4"), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
      expectDeadLettered(state, "send_check_failed", "inbound-e4");
    });

    it("lease lost retries while attempts remain and is dead-lettered + flagged on the last", async () => {
      const state = createMockState();
      state.renewLost = true;
      installSendMock(state);
      seedInboundAt(state, "inbound-e5", at("18:00:00"));
      const supabase = createMockSupabase(state);
      const first = await dispatchAiResponse(supabase as never, inp("inbound-e5"), anthropic);
      expect(first).toMatchObject({ outcome: "retry", reason: "send_lease_lost" });
      expect(state.deadLetters ?? []).toHaveLength(0);
      const last = await dispatchAiResponse(supabase as never, inp("inbound-e5", { retryAttempt: 3, retryReply: CARRIED }), anthropic);
      expect(last).toEqual({ outcome: "escalated", reason: "send_lease_lost" });
      expect(state.deadLetters).toEqual([expect.objectContaining({ reason: "send_lease_lost", body: "Hi there" })]);
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:send_lease_lost");
    });
  });

  describe("G. a retry reuses attempt 1's work", () => {
    it("re-sends the carried reply verbatim: no Jev/legacy classification, no generation, no humanizer", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-r", at("18:00:00"));
      vi.mocked(classifyForDispatch).mockClear();
      const result = await dispatchAiResponse(
        createMockSupabase(state) as never,
        inp("inbound-r", { retryAttempt: 1, retryReply: { ...CARRIED, body: "Carried text" } }),
        anthropic,
      );
      expect(result.outcome).toBe("sent");
      expect(vi.mocked(classifyForDispatch)).not.toHaveBeenCalled();
      expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
      expect(vi.mocked(humanizeReply)).not.toHaveBeenCalled();
      expect(vi.mocked(sendSmsToContact).mock.calls[0]![1].body).toBe("Carried text");
      expect(state.aiClaims[0]).toMatchObject({ status: "completed" });
    });

    it("a pending draft already stored for the inbound ends the retry as held (no regeneration)", async () => {
      const state = createMockState();
      state.config.outbound_mode = "hold";
      installSendMock(state);
      seedInboundAt(state, "inbound-pd", at("18:00:00"));
      state.aiReplyDrafts = [{ id: "d1", inbound_message_id: "inbound-pd", status: "pending", body: "stored" }];
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-pd", { retryAttempt: 1 }), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "draft_held" });
      expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
      expect(state.aiReplyDrafts).toHaveLength(1);
    });

    it("a stale pending row from an abandoned attempt neither counts as the reply nor blocks the retry's send", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-z", at("18:00:00"));
      // The zombie's stamped row is still pending (it will abort at the fence).
      pushOutbound(state, { id: "zombie", status: "pending", created_at: at("18:00:05"), metadata: aiReplyTo("inbound-z") });
      vi.setSystemTime(new Date(at("18:00:30")));
      const result = await dispatchAiResponse(
        createMockSupabase(state) as never,
        inp("inbound-z", { retryAttempt: 1, retryReply: CARRIED }),
        anthropic,
      );
      // Not already_replied (silent): it is retried while that row is in flight.
      expect(result).toMatchObject({ outcome: "retry", reason: "reply_pending", attempt: 2 });
    });
  });

  // ==========================================================================
  // Fix round 6: the Q8 decision table (one shared function, both gates),
  // live-handler rule 1, bounded mutations, rule 7 dead letters, rule 8 drafts.
  // ==========================================================================
  describe("round 6: Q8 decision table end to end", () => {
    const claimFor = (id: string, status: string, over: Partial<AiClaimRow> = {}): AiClaimRow => ({
      id: `claim-${id}`,
      inbound_message_id: id,
      response_kind: "sms_ai_responder_v1",
      status,
      lease_expires_at: at("18:10:00"),
      ...over,
    });

    it("Q8 rule 1 beats rule 2: a newer inbound with no live handler flags a human even though the seller was already answered", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-a", at("18:00:00"));
      vi.mocked(generateAiReply).mockImplementation(async () => {
        vi.setSystemTime(new Date(at("18:01:00")));
        pushOutbound(state, { id: "human", created_at: at("18:00:30"), status: "sent", metadata: null });
        seedInboundAt(state, "inbound-b", at("18:00:40"));
        return HAPPY_REPLY;
      });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-a"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:newer_inbound");
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });

    it("Q8 rule 1 with a live handler is silent even when an unrelated text went out (rule 3 never reached)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-a", at("18:00:00"));
      state.aiClaims.push(claimFor("inbound-b", "processing"));
      vi.mocked(generateAiReply).mockImplementation(async () => {
        vi.setSystemTime(new Date(at("18:01:00")));
        pushOutbound(state, { id: "ai-other", created_at: at("18:00:30"), metadata: aiReplyTo("different") });
        seedInboundAt(state, "inbound-b", at("18:00:40"));
        return HAPPY_REPLY;
      });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-a"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("Q8 rule 3 at the EARLY gate: an AI reply to a different inbound that already went out flags a human before any generation", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-e3", at("18:00:00"));
      pushOutbound(state, { id: "ai-o", created_at: at("18:00:20"), metadata: aiReplyTo("other") });
      vi.setSystemTime(new Date(at("18:00:30")));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-e3"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:outbound_since_claim");
      expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    });

    it("Q8 rule 2 at the early gate: an AI reply for THIS inbound that was sent is already_replied (silent)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-e2", at("18:00:00"));
      pushOutbound(state, { id: "ai-same", created_at: at("18:00:20"), metadata: aiReplyTo("inbound-e2") });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-e2"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "already_replied" });
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("an AI row for this inbound that FAILED is not 'already replied': the early gate continues and the reply is sent", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-fr", at("18:00:00"));
      pushOutbound(state, { id: "ai-failed", status: "failed", created_at: at("18:00:20"), metadata: aiReplyTo("inbound-fr") });
      vi.setSystemTime(new Date(at("18:00:30")));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-fr"), anthropic);
      expect(result.outcome).toBe("sent");
    });

    it("Q8 rule 4: an AI reply to THIS inbound that is only queued is pending, not answered: retried", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-q1", at("18:00:00"));
      landDuringGeneration(state, [{ id: "ai-q", status: "queued", metadata: aiReplyTo("inbound-q1") }]);
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-q1"), anthropic);
      expect(result).toMatchObject({ outcome: "retry", reason: "reply_pending", attempt: 1 });
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("Q8 rule 4: an AI reply to a DIFFERENT inbound that is still pending is pending, not unrelated: retried, not flagged", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-q2", at("18:00:00"));
      landDuringGeneration(state, [{ id: "ai-p", status: "pending", metadata: aiReplyTo("other") }]);
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-q2"), anthropic);
      expect(result).toMatchObject({ outcome: "retry", reason: "reply_pending", attempt: 1 });
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("Q8 rule 4: a queued rep text scheduled for the future is silent: no retry, no flag, no send", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-q3", at("18:00:00"));
      landDuringGeneration(state, [{ id: "rep", status: "queued", scheduled_for: at("20:00:00"), metadata: null }]);
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-q3"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "rep_text_scheduled" });
      expect(state.property.needs_human_attention).toBe(false);
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });

    it("Q8 rule 4 ordering: a scheduled rep text is silent at the EARLY gate too (no generation)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-q4", at("18:00:00"));
      pushOutbound(state, { id: "rep", status: "queued", created_at: at("18:00:10"), scheduled_for: at("20:00:00"), metadata: null });
      vi.setSystemTime(new Date(at("18:00:30")));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-q4"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "rep_text_scheduled" });
      expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    });

    it("Q8 rule 5: only a broadcast that was SUBMITTED counts; a queued broadcast does not stop the reply", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-q5", at("18:00:00"));
      landDuringGeneration(state, [{ id: "bulk", status: "queued", campaign_id: "campaign-1" }]);
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-q5"), anthropic);
      expect(result.outcome).toBe("sent");
    });

    it("Q8 rule 6: nothing in the way, the AI reply is sent", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-q6", at("18:00:00"));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-q6"), anthropic);
      expect(result.outcome).toBe("sent");
    });

    describe("early newer-inbound check tolerates an inbound that is too young to be stamped", () => {
      const run = async (onGenerate?: (state: MockState) => void) => {
        const state = createMockState();
        installSendMock(state);
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        seedInboundAt(state, "inbound-y", at("18:00:03"));
        vi.setSystemTime(new Date(at("18:00:05")));
        vi.mocked(generateAiReply).mockImplementation(async () => {
          onGenerate?.(state);
          return HAPPY_REPLY;
        });
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), { ...anthropic, checkSuperseded: true });
        return { state, result };
      };

      it("defers to the pre-send check instead of flagging at the early gate; the pre-send check is final", async () => {
        const { state, result } = await run();
        expect(vi.mocked(generateAiReply)).toHaveBeenCalledTimes(1); // the early gate did not decide
        expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
        expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:newer_inbound");
      });

      it("a newer inbound that gets its reply workflow stamped in the meantime is silent", async () => {
        const { state, result } = await run((st) => {
          st.messages.find((m) => m.id === "inbound-y")!.metadata = {
            processing: { aiResponder: { outcome: "delayed", workflowRunId: "wf_9" } },
          };
        });
        expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
        expect(state.property.needs_human_attention).toBe(false);
      });
    });
  });

  describe("round 6: first-attempt 45s throttle is classified by the same table", () => {
    it("a recent AI reply to a DIFFERENT inbound that went out flags a human (never a silent drop)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-x", at("17:59:40"));
      pushOutbound(state, { id: "ai-w", created_at: at("17:59:50"), sent_at: at("17:59:50"), metadata: aiReplyTo("inbound-w") });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:outbound_since_claim");
      expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
    });

    it("rules 3/5 are bounded since the seller's inbound: AI reply R to X, seller answers Y 20s later -> Y gets a reply (rule 6), the 45s throttle does not widen the window", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-y", at("18:00:00"));
      pushOutbound(state, { id: "ai-r", created_at: at("17:59:40"), sent_at: at("17:59:40"), metadata: aiReplyTo("inbound-x") });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-y"), anthropic);
      expect(result.outcome).toBe("sent");
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("a rep text sent just before the seller's inbound is not rule 3 (rule 6: send)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-y", at("18:00:00"));
      pushOutbound(state, { id: "rep-1", created_at: at("17:59:58"), sent_at: at("17:59:58"), metadata: null });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-y"), anthropic);
      expect(result.outcome).toBe("sent");
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("a broadcast that went out before the seller's inbound is not rule 5 (rule 6: send)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-y", at("18:00:00"));
      pushOutbound(state, { id: "bc-1", created_at: at("17:59:58"), sent_at: at("17:59:58"), campaign_id: "camp-1", metadata: null });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-y"), anthropic);
      expect(result.outcome).toBe("sent");
    });

    it("a broadcast submitted AFTER the seller's inbound is still rule 5: silent skip", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-y", at("17:59:50"));
      pushOutbound(state, { id: "bc-2", created_at: at("17:59:58"), sent_at: at("17:59:58"), campaign_id: "camp-1", metadata: null });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-y"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "superseded_by_broadcast" });
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("a recent AI reply that is still pending is rule 4: retried (no reply generated yet, nothing to carry), flagged only after the last attempt", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      pushOutbound(state, { id: "ai-w", status: "pending", created_at: at("17:59:50"), metadata: aiReplyTo("inbound-w") });
      const first = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
      expect(first).toEqual({ outcome: "retry", reason: "reply_pending", attempt: 1, delaySeconds: 20 });
      expect(state.property.needs_human_attention).toBe(false);
      const last = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x", { retryAttempt: 3 }), anthropic);
      expect(last).toEqual({ outcome: "escalated", reason: "reply_pending" });
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:reply_pending");
    });
  });

  describe("round 6: a retry short-circuits to its carried reply", () => {
    it("a pacing gate that trips during the retry gap HOLDS the reply as a draft and flags with the text dead-lettered (never a silent drop)", async () => {
      for (const reason of ["outside_business_hours", "max_turns_reached"] as const) {
        const state = createMockState();
        installSendMock(state);
        seedInboundAt(state, "inbound-pace", at("18:00:00"));
        vi.mocked(classifyAiSkip).mockReturnValue({ skip: true, reason });
        const result = await dispatchAiResponse(
          createMockSupabase(state) as never,
          inp("inbound-pace", { retryAttempt: 1, retryReply: CARRIED }),
          anthropic,
        );
        expect(result, reason).toEqual({ outcome: "escalated", reason });
        expect(vi.mocked(sendSmsToContact), reason).not.toHaveBeenCalled();
        expect(vi.mocked(classifyForDispatch), reason).not.toHaveBeenCalled();
        expect(state.aiReplyDrafts, reason).toEqual([expect.objectContaining({ status: "pending", body: "Hi there", inbound_message_id: "inbound-pace" })]);
        expect(state.deadLetters, reason).toEqual([expect.objectContaining({ body: "Hi there", reason })]);
        expect(state.property.last_ai_escalation_reason, reason).toBe(`reply_skipped:${reason}`);
        vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
      }
    });

    it("an org/property/consent suppression during the gap ends quietly (the AI may not answer at all)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-sup", at("18:00:00"));
      vi.mocked(classifyAiSkip).mockReturnValue({ skip: true, reason: "disabled_per_property" });
      const result = await dispatchAiResponse(
        createMockSupabase(state) as never,
        inp("inbound-sup", { retryAttempt: 1, retryReply: CARRIED }),
        anthropic,
      );
      expect(result).toEqual({ outcome: "skipped", reason: "disabled_per_property" });
      expect(state.property.needs_human_attention).toBe(false);
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });

    it("a retry never runs the throttle: an unrelated reply is classified once, by the pre-send table, with the carried text dead-lettered", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-t", at("18:00:00"));
      pushOutbound(state, { id: "ai-w", created_at: at("18:00:10"), metadata: aiReplyTo("other") });
      vi.setSystemTime(new Date(at("18:00:30")));
      const result = await dispatchAiResponse(
        createMockSupabase(state) as never,
        inp("inbound-t", { retryAttempt: 1, retryReply: CARRIED }),
        anthropic,
      );
      // Early gate, rule 3 (not the throttle's reason).
      expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });
  });

  describe("round 6: Q8 rule 7 - every other 'not sent' exit flags and dead-letters", () => {
    const setup = () => {
      const state = createMockState();
      installSendMock(state);
      return state;
    };
    const deadLettered = (state: MockState, reason: string, inbound: string) =>
      expect(state.deadLetters).toEqual([expect.objectContaining({ inbound_message_id: inbound, body: "Hi there", reason })]);

    it("claim_refused_on_retry dead-letters the carried reply", async () => {
      const state = setup();
      seedInboundAt(state, "inbound-cr", at("18:00:00"));
      state.aiClaims.push({ id: "claim-cr", inbound_message_id: "inbound-cr", response_kind: "sms_ai_responder_v1", status: "processing", lease_expires_at: at("18:05:00") });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-cr", { retryAttempt: 1, retryReply: CARRIED }), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "already_claimed" });
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:claim_refused_on_retry");
      deadLettered(state, "claim_refused_on_retry", "inbound-cr");
    });

    it("a dead letter that cannot be written changes the flag to dead_letter_failed:<reason> (claim refused)", async () => {
      const state = setup();
      state.deadLetterInsertError = { message: "dl boom" };
      seedInboundAt(state, "inbound-cr2", at("18:00:00"));
      state.aiClaims.push({ id: "claim-cr2", inbound_message_id: "inbound-cr2", response_kind: "sms_ai_responder_v1", status: "processing", lease_expires_at: at("18:05:00") });
      await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-cr2", { retryAttempt: 1, retryReply: CARRIED }), anthropic);
      expect(state.deadLetterInsertAttempts).toBe(2);
      expect(state.property.last_ai_escalation_reason).toBe("dead_letter_failed:claim_refused_on_retry");
    });

    it("send_blocked:db_error (sender lookup) dead-letters", async () => {
      const state = setup();
      seedInboundAt(state, "inbound-db", at("18:00:00"));
      const supabase = createMockSupabase(state);
      interceptMessageSelect(supabase, "to_address", { error: { message: "lookup boom" } });
      const result = await dispatchAiResponse(supabase as never, inp("inbound-db"), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_blocked:db_error" });
      expect(state.property.last_ai_escalation_reason).toBe("send_blocked:db_error");
      deadLettered(state, "send_blocked:db_error", "inbound-db");
    });

    it("any other blocked send status (send_blocked:<status>) dead-letters, and a failed dead letter says so", async () => {
      for (const failDeadLetter of [false, true]) {
        const state = setup();
        if (failDeadLetter) state.deadLetterInsertError = { message: "dl boom" };
        seedInboundAt(state, "inbound-bl", at("18:00:00"));
        vi.mocked(sendSmsToContact).mockResolvedValue({ status: "provider_failed", messageId: "m1", error: "nope" } as never);
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-bl"), anthropic);
        expect(result).toEqual({ outcome: "escalated", reason: "send_blocked:provider_failed" });
        if (failDeadLetter) {
          expect(state.property.last_ai_escalation_reason).toBe("dead_letter_failed:send_blocked:provider_failed");
        } else {
          expect(state.property.last_ai_escalation_reason).toBe("send_blocked:provider_failed");
          deadLettered(state, "send_blocked:provider_failed", "inbound-bl");
        }
        vi.clearAllMocks();
        vi.mocked(getConsentState).mockResolvedValue({} as never);
        vi.mocked(classifyAiSkip).mockReturnValue({ skip: false });
        vi.mocked(generateAiReply).mockResolvedValue(HAPPY_REPLY);
        vi.mocked(humanizeReply).mockImplementation(async ({ draft }) => draft);
        vi.mocked(validateAiReplyBody).mockReturnValue({ ok: true });
      }
    });

    it("a refused submission whose row could not be retired is never retried over: dead-lettered and flagged", async () => {
      const state = setup();
      seedInboundAt(state, "inbound-ab", at("18:00:00"));
      vi.mocked(sendSmsToContact).mockResolvedValue({ status: "blocked_before_provider", messageId: "m1", retired: false } as never);
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-ab"), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_blocked:abort_unconfirmed" });
      deadLettered(state, "send_blocked:abort_unconfirmed", "inbound-ab");
    });

    it("an earlier attempt's FAILED stamped row is flagged, never 'already replied'", async () => {
      const state = setup();
      seedInboundAt(state, "inbound-pf", at("18:00:00"));
      vi.mocked(sendSmsToContact).mockImplementation(async () => {
        pushOutbound(state, { id: "old-failed", status: "failed", created_at: at("17:59:00"), metadata: aiReplyTo("inbound-pf") });
        return { status: "db_error", error: "duplicate key value violates unique constraint idx_messages_ai_responder_inbound_unique" } as never;
      });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-pf"), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_blocked:prior_attempt_failed" });
      deadLettered(state, "send_blocked:prior_attempt_failed", "inbound-pf");
    });

    it("a provider timeout whose dead letter cannot be written is flagged dead_letter_failed:send_timeout", async () => {
      vi.useRealTimers();
      Object.assign(sendReservationTuning, { providerTimeoutMs: 20 });
      const state = setup();
      state.deadLetterInsertError = { message: "dl boom" };
      seedInboundAt(state, "inbound-to", at("18:00:00"));
      vi.mocked(sendSmsToContact).mockImplementation(async (_s, input) => {
        await input.beforeProviderSubmit?.();
        return new Promise(() => undefined);
      });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-to"), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_timeout" });
      expect(state.property.last_ai_escalation_reason).toBe("dead_letter_failed:send_timeout");
    });

    it("a competitor still queued after the LAST attempt flags with the text dead-lettered (and dead_letter_failed when that fails)", async () => {
      for (const failDeadLetter of [false, true]) {
        const state = setup();
        if (failDeadLetter) state.deadLetterInsertError = { message: "dl boom" };
        seedInboundAt(state, "inbound-lq", at("18:00:00"));
        pushOutbound(state, { id: "human-q", status: "queued", created_at: at("18:00:05"), metadata: null });
        vi.setSystemTime(new Date(at("18:00:10")));
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-lq", { retryAttempt: 3, retryReply: CARRIED }), anthropic);
        expect(result).toEqual({ outcome: "escalated", reason: "reply_pending" });
        expect(state.property.last_ai_escalation_reason).toBe(failDeadLetter ? "dead_letter_failed:reply_pending" : "reply_skipped:reply_pending");
      }
    });
  });

  describe("round 6: Q8 rule 8 - a discarded or sent draft is never revived", () => {
    const heldThenDiscarded = async (body: string) => {
      const state = createMockState();
      state.config.outbound_mode = "hold";
      installSendMock(state);
      seedInboundAt(state, "inbound-d8", at("18:00:00"));
      const supabase = createMockSupabase(state);
      const first = await dispatchAiResponse(supabase as never, { ...inp("inbound-d8"), inboundBody: body }, anthropic);
      expect(first).toEqual({ outcome: "escalated", reason: "draft_held" });
      // A human discards the draft; the owner flips the mode to send; the run's
      // claim is parked for a retry.
      state.aiReplyDrafts![0]!.status = "discarded";
      state.config.outbound_mode = "send";
      state.property.needs_human_attention = false;
      Object.assign(state.aiClaims[0]!, { status: "error", error_message: "retry_scheduled:send_lease_lost:1", lease_expires_at: at("17:00:00") });
      vi.setSystemTime(new Date(at("18:00:30")));
      return { state, supabase };
    };

    it("draft held -> human discards -> mode flips to send -> the retry (with the carried reply) does not send", async () => {
      const { state, supabase } = await heldThenDiscarded("Still interested?");
      const retry = await dispatchAiResponse(supabase as never, inp("inbound-d8", { retryAttempt: 1, retryReply: CARRIED }), anthropic);
      expect(retry).toEqual({ outcome: "skipped", reason: "already_answered" });
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
      expect(state.aiReplyDrafts).toHaveLength(1);
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("the same holds for a retry that has no carried reply", async () => {
      const { state, supabase } = await heldThenDiscarded("Still interested?");
      const retry = await dispatchAiResponse(supabase as never, inp("inbound-d8", { retryAttempt: 1 }), anthropic);
      expect(retry).toEqual({ outcome: "skipped", reason: "already_answered" });
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
      expect(vi.mocked(generateAiReply)).toHaveBeenCalledTimes(1); // only the first attempt
      expect(state.aiReplyDrafts).toHaveLength(1);
    });

    it("an identity reply is checked too (replayed identity text never revives a discarded draft)", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-id8", at("18:00:00"));
      state.aiReplyDrafts = [{ id: "d9", inbound_message_id: "inbound-id8", status: "discarded", body: IDENTITY_REPLY_BODY }];
      const result = await dispatchAiResponse(createMockSupabase(state) as never, { ...inp("inbound-id8"), inboundBody: "Who is this?" }, anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "already_answered" });
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });

    it("a sent draft is the same: silent already_answered", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-sd8", at("18:00:00"));
      state.aiReplyDrafts = [{ id: "d10", inbound_message_id: "inbound-sd8", status: "sent", body: "old" }];
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-sd8", { retryAttempt: 1, retryReply: CARRIED }), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "already_answered" });
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });

    it("an unreadable draft state fails closed (dead letter + flag), never a send", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-dl8", at("18:00:00"));
      state.draftLookupError = true;
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-dl8"), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
      expect(state.deadLetters).toEqual([expect.objectContaining({ body: "Hi there", reason: "send_check_failed" })]);
    });
  });

  describe("round 6: a refused submission leaves the AI shape every reader understands", () => {
    it("a retired (failed) AI row keeps generated_by but not the inbound key: it is neither a reply nor a max-turns turn, and the retry sends", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-sh", at("18:00:00"));
      pushOutbound(state, {
        id: "aborted",
        status: "failed",
        created_at: at("18:00:05"),
        metadata: { generated_by: "ai_responder_v1", aborted_inbound_message_id: "inbound-sh", abortedBeforeProvider: true },
      });
      vi.setSystemTime(new Date(at("18:00:30")));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-sh", { retryAttempt: 1, retryReply: CARRIED }), anthropic);
      expect(result.outcome).toBe("sent");
    });

    it("max_turns counts delivered AI turns only, never a failed or retired row", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-mt", at("18:00:00"));
      pushOutbound(state, { id: "failed-ai", status: "failed", created_at: at("17:00:00"), metadata: { generated_by: "ai_responder_v1", aborted_inbound_message_id: "x", abortedBeforeProvider: true } });
      // An identity reply retired before the provider has the marker but NO inbound key.
      pushOutbound(state, { id: "failed-identity", status: "failed", created_at: at("17:10:00"), metadata: { generated_by: "ai_responder_v1", abortedBeforeProvider: true } });
      // A row that failed AT/AFTER the provider (no marker) still counts.
      pushOutbound(state, { id: "failed-late", status: "failed", created_at: at("17:20:00"), metadata: aiReplyTo("late") });
      pushOutbound(state, { id: "sent-ai", status: "sent", created_at: at("17:30:00"), metadata: aiReplyTo("older") });
      await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-mt"), anthropic);
      expect(vi.mocked(classifyAiSkip).mock.calls[0]![0]).toMatchObject({ currentTurn: 2 });
    });

    it("a failed max-turns count fails CLOSED (rule 7): no reply, flagged send_check_failed, nothing generated or sent", async () => {
      const state = createMockState();
      state.turnCountError = true;
      installSendMock(state);
      seedInboundAt(state, "inbound-tc", at("18:00:00"));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-tc"), anthropic);
      expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
      expect(state.property.needs_human_attention).toBe(true);
      expect(state.property.last_ai_escalation_reason).toBe("send_check_failed");
      expect(vi.mocked(generateAiReply)).not.toHaveBeenCalled();
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });

    it("a failed max-turns count on a retry that carries a reply dead-letters the reply and flags send_check_failed", async () => {
      const state = createMockState();
      state.turnCountError = true;
      installSendMock(state);
      seedInboundAt(state, "inbound-tc2", at("18:00:00"));
      const result = await dispatchAiResponse(
        createMockSupabase(state) as never,
        inp("inbound-tc2", {
          retryAttempt: 1,
          retryReply: { body: "carried text", confidence: 0.9, sentiment: "neutral", orgId: "org-1", kind: "send_reply" },
        }),
        anthropic,
      );
      expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
      expect(state.deadLetters).toHaveLength(1);
      expect(state.deadLetters![0]).toMatchObject({ body: "carried text", reason: "send_check_failed" });
      expect(state.property.last_ai_escalation_reason).toBe("send_check_failed");
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    });
  });

  describe("round 6: an abandoned attempt can neither mutate nor hang cleanup", () => {
    it("a gate read that resumes AFTER the attempt timed out cannot flag the property", async () => {
      const state = createMockState();
      installSendMock(state);
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      // A newer, unhandled inbound: the decision this paused read reaches is "flag".
      seedInboundAt(state, "inbound-y", at("18:00:30"));
      const supabase = createMockSupabase(state);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      interceptMessageSelect(supabase, "id, created_at", { gate });
      const pending = dispatchAiResponse(supabase as never, inp("inbound-x"), anthropic);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(sendReservationTuning.providerTimeoutMs + 1_000);
      const result = await pending;
      expect(result).toMatchObject({ outcome: "retry", reason: "send_preflight_timeout", attempt: 1 });
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(state.property.needs_human_attention).toBe(false);
      expect(state.property.last_ai_escalation_reason).toBeUndefined();
      expect(state.deadLetters ?? []).toHaveLength(0);
    });

    it("a hung lease-release RPC is bounded by its own short deadline: the retry is still scheduled", async () => {
      const state = createMockState();
      state.renewLost = true;
      installSendMock(state);
      seedInboundAt(state, "inbound-hr", at("18:00:00"));
      const supabase = createMockSupabase(state);
      const realRpc = supabase.rpc.bind(supabase);
      supabase.rpc = ((name: string, args: Record<string, unknown>) =>
        name === "fn_release_ai_send" ? new Promise(() => undefined) : realRpc(name, args)) as never;
      const pending = dispatchAiResponse(supabase as never, inp("inbound-hr"), anthropic);
      await vi.advanceTimersByTimeAsync(sendReservationTuning.releaseTimeoutMs + 100);
      const result = await pending;
      expect(result).toMatchObject({ outcome: "retry", reason: "send_lease_lost", attempt: 1 });
      expect(reportErrorMock).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({ tags: { surface: "ai_responder_send_release_timeout" } }),
      );
      expect(state.property.needs_human_attention).toBe(false);
    });
  });

  describe("round 8: claim outcomes carry the silent rule, rule 0 evidence, flag proof", () => {
    const setup = () => {
      const state = createMockState();
      installSendMock(state);
      return state;
    };
    const claimFor = (state: MockState, inbound: string) => state.aiClaims.find((c) => c.inbound_message_id === inbound);

    it.each([
      [
        "skipped:rule_2",
        (state: MockState) => pushOutbound(state, { id: "rep-after", created_at: at("18:00:05"), sent_at: at("18:00:05"), metadata: null }),
      ],
      [
        "skipped:rule_5",
        (state: MockState) => pushOutbound(state, { id: "bc-after", created_at: at("18:00:05"), sent_at: at("18:00:05"), campaign_id: "camp-1", metadata: null }),
      ],
      [
        "skipped:rule_4",
        (state: MockState) =>
          pushOutbound(state, { id: "rep-sched", status: "queued", created_at: at("18:00:05"), scheduled_for: at("23:00:00"), metadata: null }),
      ],
    ])("a run that ends silently under the lease records %s on its claim", async (outcome, inject) => {
      const state = setup();
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      state.onReserved = () => inject(state);
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
      expect(result.outcome).toBe("skipped");
      expect(claimFor(state, "inbound-x")).toMatchObject({ status: "completed", outcome });
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("rule 0 under the lease records skipped:rule_0; a discarded draft records skipped:rule_8", async () => {
      const a = setup();
      seedInboundAt(a, "inbound-x", at("18:00:00"));
      a.onReserved = () => vi.mocked(getConsentState).mockResolvedValue("opted_out" as never);
      await dispatchAiResponse(createMockSupabase(a) as never, inp("inbound-x"), anthropic);
      expect(claimFor(a, "inbound-x")).toMatchObject({ status: "completed", outcome: "skipped:rule_0" });

      vi.mocked(getConsentState).mockResolvedValue({} as never);
      const b = setup();
      seedInboundAt(b, "inbound-x", at("18:00:00"));
      b.onReserved = () => {
        (b.aiReplyDrafts ??= []).push({ id: "d1", inbound_message_id: "inbound-x", status: "discarded" });
      };
      await dispatchAiResponse(createMockSupabase(b) as never, inp("inbound-x"), anthropic);
      expect(claimFor(b, "inbound-x")).toMatchObject({ status: "completed", outcome: "skipped:rule_8" });
    });

    it("a flagged skip (rule 3) completes its claim as escalated, never as a bare skipped", async () => {
      const state = setup();
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      state.onReserved = () =>
        pushOutbound(state, { id: "ai-other", created_at: at("18:00:05"), sent_at: at("18:00:05"), metadata: aiReplyTo("inbound-w") });
      await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
      expect(state.property.needs_human_attention).toBe(true);
      expect(claimFor(state, "inbound-x")).toMatchObject({ status: "completed", outcome: "escalated" });
    });

    it("end to end: B ends silently under rule 2, then A's pre-send sees B as handled (no flag)", async () => {
      const state = setup();
      seedInboundAt(state, "inbound-a", at("18:00:00"));
      seedInboundAt(state, "inbound-b", at("18:00:05"));
      // B's run: a rep text lands after B's inbound while it holds the lease.
      state.onReserved = () => {
        state.onReserved = undefined;
        pushOutbound(state, { id: "rep-b", created_at: at("18:00:10"), sent_at: at("18:00:10"), metadata: null });
      };
      vi.setSystemTime(new Date(at("18:01:00")));
      const supabase = createMockSupabase(state);
      const b = await dispatchAiResponse(supabase as never, inp("inbound-b"), anthropic);
      expect(b.outcome).toBe("skipped");
      expect(claimFor(state, "inbound-b")?.outcome).toBe("skipped:rule_2");
      const a = await dispatchAiResponse(supabase as never, inp("inbound-a"), { ...anthropic, checkSuperseded: true });
      expect(a).toEqual({ outcome: "skipped", reason: "superseded_by_newer_inbound" });
      expect(state.property.needs_human_attention).toBe(false);
    });

    describe("rule 0 evidence includes the SENDER's own suppression", () => {
      it.each([
        ["contact do_not_contact", (st: MockState) => { st.contact.do_not_contact = true; }, "contact_do_not_contact"],
        ["contact sms_opted_out", (st: MockState) => { st.contact.sms_opted_out = true; }, "contact_sms_opted_out"],
        ["a suppressed destination phone", (st: MockState) => { st.phoneSuppressions = ["+18165550001"]; }, "phone_suppressed"],
      ])("%s ends silently (rule 0) before rule 1 even with an UNHANDLED newer inbound, nothing flagged", async (_label, arm, reason) => {
        const state = setup();
        arm(state);
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        seedInboundAt(state, "inbound-y", at("18:00:05"));
        vi.setSystemTime(new Date(at("18:01:00")));
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), { ...anthropic, checkSuperseded: true });
        expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
        expect(state.property.needs_human_attention).toBe(false);
        expect(result).toEqual({ outcome: "skipped", reason });
      });

      it.each([
        ["contact do_not_contact", (st: MockState) => { st.contact.do_not_contact = true; }],
        ["contact sms_opted_out", (st: MockState) => { st.contact.sms_opted_out = true; }],
        ["a suppressed destination phone", (st: MockState) => { st.phoneSuppressions = ["+18165550001"]; }],
      ])("hold path: %s never produces a held draft or a draft_held flag", async (_label, arm) => {
        const state = setup();
        state.config.outbound_mode = "hold";
        arm(state);
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(result.outcome).toBe("skipped");
        expect(state.aiReplyDrafts ?? []).toHaveLength(0);
        expect(state.property.needs_human_attention).toBe(false);
        expect(state.deadLetters ?? []).toHaveLength(0);
        expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
      });

      it("a failed phone-suppression lookup is rule 7, not a silent pass: flagged send_check_failed, reply dead-lettered, nothing sent", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        // The early gate tolerates a failed read (the pre-send check is strict); fail it only under the lease.
        state.onReserved = () => { state.phoneSuppressionError = true; };
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
        expect(state.property.last_ai_escalation_reason).toBe("send_check_failed");
        expect(state.deadLetters).toEqual([expect.objectContaining({ reason: "send_check_failed", body: "Hi there" })]);
        expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
      });
    });

    describe("an escalation must prove its flag persisted", () => {
      it("a failed flag write is never recorded as handled: the claim completes as error flag_failed (no reply exists: nothing to dead-letter)", async () => {
        const state = setup();
        state.flagWriteError = true;
        vi.mocked(generateAiReply).mockResolvedValue({ ...HAPPY_REPLY, confidence: 0.1 });
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(result.outcome).toBe("escalated");
        expect(state.property.needs_human_attention).toBe(false);
        expect(claimFor(state, "inbound-x")).toMatchObject({ status: "error", error_message: "flag_failed" });
        // ...and therefore a newer-inbound check reads it as NOT handled.
      });

      it("the same escalation with a working flag completes the claim as escalated (handled)", async () => {
        const state = setup();
        vi.mocked(generateAiReply).mockResolvedValue({ ...HAPPY_REPLY, confidence: 0.1 });
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(state.property.needs_human_attention).toBe(true);
        expect(claimFor(state, "inbound-x")).toMatchObject({ status: "completed", outcome: "escalated" });
      });

      it("a flagged skip whose flag write fails dead-letters the reply and completes the claim as error flag_failed", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        state.onReserved = () => {
          pushOutbound(state, { id: "ai-other", created_at: at("18:00:05"), sent_at: at("18:00:05"), metadata: aiReplyTo("inbound-w") });
          state.flagWriteError = true;
        };
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(result).toEqual({ outcome: "escalated", reason: "flag_failed" });
        expect(state.deadLetters).toEqual([expect.objectContaining({ reason: "flag_failed", body: "Hi there" })]);
        expect(claimFor(state, "inbound-x")).toMatchObject({ status: "error", error_message: "flag_failed" });
      });

      it("markPropertyNeedsAttention reports success only when the flag exists or was written", async () => {
        const { markPropertyNeedsAttention } = await import("./dispatch");
        const state = setup();
        const supabase = createMockSupabase(state);
        expect(await markPropertyNeedsAttention(supabase as never, PROPERTY_ID, "r1")).toBe(true);
        expect(state.property.needs_human_attention).toBe(true);
        // already flagged: the exists-check proves it
        expect(await markPropertyNeedsAttention(supabase as never, PROPERTY_ID, "r2")).toBe(true);
        const failing = setup();
        failing.flagWriteError = true;
        expect(await markPropertyNeedsAttention(createMockSupabase(failing) as never, PROPERTY_ID, "r3")).toBe(false);
      });

      it("a failing lead-event write after a persisted flag does not turn the flag into a failure", async () => {
        const { markPropertyNeedsAttention } = await import("./dispatch");
        recordLeadEvent.mockRejectedValueOnce(new Error("ledger down"));
        const state = setup();
        expect(await markPropertyNeedsAttention(createMockSupabase(state) as never, PROPERTY_ID, "r")).toBe(true);
        expect(state.property.needs_human_attention).toBe(true);
      });
    });
  });

  describe("round 7: rule 0 / rule 8 first, completed != handled, evidence, guards", () => {
    const setup = () => {
      const state = createMockState();
      installSendMock(state);
      return state;
    };
    const deadLettered = (state: MockState, reason: string) =>
      expect(state.deadLetters ?? []).toEqual([expect.objectContaining({ reason })]);

    it("(g) rule 0 before rule 1: a suppressed lead with an UNHANDLED newer inbound ends silently, nothing flagged", async () => {
      const state = setup();
      state.property.outreach_dispo = "wrong_number";
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      seedInboundAt(state, "inbound-y", at("18:00:05"));
      vi.setSystemTime(new Date(at("18:01:00")));
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), { ...anthropic, checkSuperseded: true });
      expect(result).toEqual({ outcome: "skipped", reason: "already_terminal" });
      expect(state.property.needs_human_attention).toBe(false);
      expect(state.property.last_ai_escalation_reason).toBeUndefined();
    });

    it("(g) rule 0 before rule 1: AI disabled for the property + unhandled newer inbound -> existing skip reason, nothing flagged", async () => {
      const state = setup();
      state.property.ai_responder_disabled = true;
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      seedInboundAt(state, "inbound-y", at("18:00:05"));
      vi.setSystemTime(new Date(at("18:01:00")));
      vi.mocked(classifyAiSkip).mockReturnValue({ skip: true, reason: "disabled_per_property" });
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), { ...anthropic, checkSuperseded: true });
      expect(result).toEqual({ outcome: "skipped", reason: "disabled_per_property" });
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("rule 0 under the send lease: the seller opts out between the early gate and the send -> silent, no provider call, no flag", async () => {
      const state = setup();
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      state.onReserved = () => {
        vi.mocked(getConsentState).mockResolvedValue("opted_out" as never);
      };
      const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
      expect(result).toEqual({ outcome: "skipped", reason: "no_consent" });
      expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
      expect(state.property.needs_human_attention).toBe(false);
    });

    it("(a) a newer inbound that tripped a pacing gate (Jev use_legacy) does NOT read as a live handler: the older reply is flagged", async () => {
      const state = setup();
      state.config.classifier_provider = "jev";
      seedInboundAt(state, "inbound-x", at("18:00:00"));
      seedInboundAt(state, "inbound-y", at("18:00:05"));
      vi.setSystemTime(new Date(at("18:01:00")));
      const supabase = createMockSupabase(state);
      vi.mocked(classifyAiSkip).mockReturnValueOnce({ skip: true, reason: "outside_business_hours" });
      vi.mocked(classifyForDispatch).mockResolvedValueOnce({ kind: "use_legacy", classificationRunId: null } as never);
      const b = await dispatchAiResponse(supabase as never, inp("inbound-y"), anthropic);
      expect(b).toEqual({ outcome: "skipped", reason: "outside_business_hours" });
      // The claim B took is settled, never left `processing` with a fresh lease.
      expect(state.aiClaims.find((c) => c.inbound_message_id === "inbound-y")).toMatchObject({
        status: "error",
        error_message: "reply_ineligible",
      });
      const a = await dispatchAiResponse(supabase as never, inp("inbound-x"), { ...anthropic, checkSuperseded: true });
      expect(a).toEqual({ outcome: "skipped", reason: "superseded_by_newer_inbound" });
      expect(state.property.last_ai_escalation_reason).toBe("reply_skipped:newer_inbound");
    });

    describe("(5) evidence collection", () => {
      it("a rep text created BEFORE the inbound but scheduled for the future and still queued is a rule-4 silent skip", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        pushOutbound(state, { id: "rep-q", status: "queued", created_at: at("12:00:00"), sent_at: null, scheduled_for: "2026-06-13T20:00:00.000Z", metadata: null });
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(result).toEqual({ outcome: "skipped", reason: "rep_text_scheduled" });
        expect(state.property.needs_human_attention).toBe(false);
        expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
      });
      it("a non-SMS outbound is not evidence", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        pushOutbound(state, { id: "mail", channel: "email", created_at: at("18:00:03"), status: "sent" });
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(result.outcome).toBe("sent");
      });
      it("'went out' is the submission time: a rep text created before the inbound but SENT after it already answered the seller (silent)", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        pushOutbound(state, { id: "rep", created_at: at("17:00:00"), sent_at: at("18:00:20"), status: "sent", metadata: null });
        vi.setSystemTime(new Date(at("18:00:30")));
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(result).toEqual({ outcome: "skipped", reason: "already_answered" });
        expect(state.property.needs_human_attention).toBe(false);
      });
      it("a text sent before the inbound (outside the evidence window) is not evidence: the reply goes out", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        pushOutbound(state, { id: "rep", created_at: at("17:59:50"), sent_at: at("17:59:55"), status: "sent", metadata: null });
        vi.setSystemTime(new Date(at("18:00:30")));
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(result.outcome).toBe("sent");
      });
      it("more than 500 outstanding competitors cannot be read completely: fails closed (send_check_failed), evidence_truncated, nothing sent", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        for (let i = 0; i < 501; i += 1) {
          pushOutbound(state, { id: `q-${i}`, status: "queued", created_at: at("18:00:01"), sent_at: null, campaign_id: "camp" });
        }
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        expect(result).toEqual({ outcome: "escalated", reason: "send_check_failed" });
        expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
        expect(state.property.last_ai_escalation_reason).toBe("send_check_failed");
        deadLettered(state, "send_check_failed");
      });
    });

    describe("(6) max-turns counting", () => {
      it("excludes ONLY rows retired before the provider; rows that failed at/after the provider still count", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-x", at("18:00:00"));
        const ai = (inbound: string, extra: Record<string, unknown> = {}) => ({ generated_by: "ai_responder_v1", inbound_message_id: inbound, ...extra });
        pushOutbound(state, { id: "t-sent", status: "sent", created_at: at("17:00:00"), sent_at: at("17:00:00"), metadata: ai("a") });
        pushOutbound(state, { id: "t-failed-after", status: "failed", created_at: at("17:01:00"), sent_at: null, metadata: ai("b") });
        pushOutbound(state, {
          id: "t-aborted",
          status: "failed",
          created_at: at("17:02:00"),
          sent_at: null,
          metadata: { generated_by: "ai_responder_v1", aborted_inbound_message_id: "c", abortedBeforeProvider: true },
        });
        await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-x"), anthropic);
        const calls = vi.mocked(classifyAiSkip).mock.calls;
        expect(calls[0]![0]).toMatchObject({ currentTurn: 2 });
      });
    });

    describe("(4) duplicate-insert fallback: only a row the provider accepted answers the seller", () => {
      const dup = (state: MockState, status: string, extra: Record<string, unknown> = {}) =>
        vi.mocked(sendSmsToContact).mockImplementation(async () => {
          pushOutbound(state, { id: "old", status, created_at: at("17:59:00"), sent_at: null, metadata: aiReplyTo("inbound-d"), ...extra });
          return { status: "db_error", error: "duplicate key value violates unique constraint idx_messages_ai_responder_inbound_unique" } as never;
        });
      it.each(["sent", "delivered"])("%s -> silent already_replied", async (status) => {
        const state = setup();
        seedInboundAt(state, "inbound-d", at("18:00:00"));
        dup(state, status);
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-d"), anthropic);
        expect(result).toEqual({ outcome: "skipped", reason: "already_replied" });
      });
      it.each(["pending", "queued"])("%s -> rule-4 retry, never silent", async (status) => {
        const state = setup();
        seedInboundAt(state, "inbound-d", at("18:00:00"));
        dup(state, status);
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-d"), anthropic);
        expect(result).toMatchObject({ outcome: "retry", reason: "send_reserved_elsewhere", attempt: 1 });
        expect(state.property.needs_human_attention).toBe(false);
      });
      it("any other status -> rule 7 send_blocked:<status>", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-d", at("18:00:00"));
        dup(state, "paused");
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-d"), anthropic);
        expect(result).toEqual({ outcome: "escalated", reason: "send_blocked:paused" });
        deadLettered(state, "send_blocked:paused");
      });
      it("a failed row retired before the provider (aborted key) does not decide: generic blocked-send handling", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-d", at("18:00:00"));
        dup(state, "failed", { metadata: { ...aiReplyTo("inbound-d"), aborted_inbound_message_id: "inbound-d" } });
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-d"), anthropic);
        expect(result).toEqual({ outcome: "escalated", reason: "send_blocked:db_error" });
      });
      it("a sent row wins over a newer failed/aborted one", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-d", at("18:00:00"));
        vi.mocked(sendSmsToContact).mockImplementation(async () => {
          pushOutbound(state, { id: "ok", status: "sent", created_at: at("17:58:00"), metadata: aiReplyTo("inbound-d") });
          pushOutbound(state, { id: "bad", status: "failed", created_at: at("17:59:00"), sent_at: null, metadata: aiReplyTo("inbound-d") });
          return { status: "db_error", error: "duplicate key value violates unique constraint idx_messages_ai_responder_inbound_unique" } as never;
        });
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-d"), anthropic);
        expect(result).toEqual({ outcome: "skipped", reason: "already_replied" });
      });
    });

    describe("(1) every mutation of an abandoned attempt is guarded", () => {
      it("a persistHeldDraft lookup that resumes after the timeout inserts nothing", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-hd", at("18:00:00"));
        // Under the lease the owner flips the mode to hold: the held-draft path runs inside the attempt.
        state.onReserved = () => {
          state.config.outbound_mode = "hold";
        };
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        // Selects #1 (early gate) and #2 (under the lease) are the rule-8 evidence
        // reads; #3 is persistHeldDraft's own lookup.
        state.draftSelectHook = (n) => (n === 3 ? gate : undefined);
        const pending = dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-hd"), anthropic);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(sendReservationTuning.providerTimeoutMs + 1_000);
        const result = await pending;
        expect(result).toMatchObject({ outcome: "retry", reason: "send_preflight_timeout" });
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(state.aiReplyDrafts ?? []).toHaveLength(0);
        expect(state.property.needs_human_attention).toBe(false);
      });

      it("a needs-attention evidence step that resumes after the deadline cannot update the property", async () => {
        const { markPropertyNeedsAttention } = await import("./dispatch");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const update = vi.fn();
        const supabase = {
          from(table: string) {
            if (table === "pipeline_run_steps") return { insert: async () => (await gate, { error: null }) };
            return { update };
          },
        };
        let live = true;
        const guard = () => {
          if (!live) throw new Error("abandoned");
        };
        const done = markPropertyNeedsAttention(supabase as never, "p1", "r", { runId: "run", orgId: "org-1", seq: 0 } as never, guard);
        live = false;
        release();
        await expect(done).rejects.toThrow("abandoned");
        expect(update).not.toHaveBeenCalled();
      });

      it("dead-letter retries are guarded before EACH insert", async () => {
        const { writeReplyDeadLetter } = await import("./retry");
        let live = true;
        const guard = () => {
          if (!live) throw new Error("abandoned");
        };
        const insert = vi.fn(async () => {
          live = false; // the attempt expires while the first insert is in flight
          return { error: { message: "boom" } };
        });
        const supabase = { from: () => ({ insert }) };
        await expect(
          writeReplyDeadLetter(supabase as never, null, {
            orgId: "o", conversationId: null, propertyId: "p", inboundMessageId: null, body: "b", reason: "r", guard,
          }),
        ).rejects.toThrow("abandoned");
        expect(insert).toHaveBeenCalledTimes(1);
      });

      it("delivery reconciliation still records a submission that completed after the deadline", async () => {
        const state = setup();
        seedInboundAt(state, "inbound-dr", at("18:00:00"));
        const result = await dispatchAiResponse(createMockSupabase(state) as never, inp("inbound-dr"), anthropic);
        expect(result.outcome).toBe("sent");
        const sent = state.messages.find((m) => m.id.startsWith("sent-"))!;
        expect(sent.metadata).toMatchObject({ generated_by: "ai_responder_v1", inbound_message_id: "inbound-dr" });
      });
    });
  });

});

describe("resolveOutboundPolicy", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("defaults to send for every source", () => {
    for (const source of ["llm", "approved_template", "human"] as const) {
      expect(resolveOutboundPolicy({ source })).toEqual({ hold: false });
    }
  });

  it("LLM_AUTOSEND=0 holds only llm", () => {
    vi.stubEnv("AI_RESPONDER_LLM_AUTOSEND", "0");
    expect(resolveOutboundPolicy({ source: "llm" })).toEqual({ hold: true, reason: "llm_autosend_off" });
    expect(resolveOutboundPolicy({ source: "approved_template" })).toEqual({ hold: false });
  });

  it("either hold wins; env send never overrides a DB hold", () => {
    vi.stubEnv("AI_RESPONDER_OUTBOUND_MODE", "send");
    expect(resolveOutboundPolicy({ source: "llm", dbMode: "hold" })).toEqual({ hold: true, reason: "outbound_mode_hold" });
    expect(resolveOutboundPolicy({ source: "llm", dbMode: "send" })).toEqual({ hold: false });
    vi.stubEnv("AI_RESPONDER_OUTBOUND_MODE", "hold");
    expect(resolveOutboundPolicy({ source: "llm", dbMode: "send" })).toEqual({ hold: true, reason: "outbound_mode_hold" });
  });

  it("ignores an invalid env mode and falls back to the DB value", () => {
    vi.stubEnv("AI_RESPONDER_OUTBOUND_MODE", "bogus");
    expect(resolveOutboundPolicy({ source: "llm", dbMode: "hold" })).toEqual({ hold: true, reason: "outbound_mode_hold" });
  });
});
