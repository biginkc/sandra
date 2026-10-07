import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConsentState } from "@/lib/messaging/consent";
import { applyPhoneLevelOptOut } from "@/lib/messaging/opt-out-phone";
import { sendSmsToContact } from "@/lib/messaging/send";

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

vi.mock("@/lib/messaging/opt-out-phone", () => ({
  applyPhoneLevelOptOut: vi.fn(),
}));

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
  channel: string;
  contact_id: string;
  conversation_id: string | null;
  created_at: string;
  direction: "inbound" | "outbound";
  metadata: Record<string, unknown> | null;
  property_id: string;
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
  reserveCalls?: number;
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
    },
  ): boolean {
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
    };
    let limitCount: number | null = null;
    let orderBy: { ascending: boolean; field: keyof MessageRow } | null = null;
    let selectOptions: { count?: string; head?: boolean } | undefined;
    let updateData: Partial<MessageRow> | null = null;

    const execute = () => {
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
      if (table === "ai_reply_drafts") {
        return {
          insert: async (row: Record<string, unknown>) => {
            if (state.draftInsertError) return { error: state.draftInsertError };
            const drafts = (state.aiReplyDrafts ??= []);
            if (
              row.status === "pending" &&
              row.inbound_message_id &&
              drafts.some(
                (d) => d.status === "pending" && d.inbound_message_id === row.inbound_message_id,
              )
            ) {
              return { error: { code: "23505", message: "duplicate pending draft" } };
            }
            drafts.push(row);
            return { error: null };
          },
        };
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

function installSendMock(state: MockState) {
  vi.mocked(sendSmsToContact).mockImplementation(async (_supabase, input) => {
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

  it("sends once, then skips a second inbound in the same conversation within 45 seconds", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);

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
    expect(second).toEqual({
      outcome: "skipped",
      reason: "duplicate_throttled",
    });
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
    Object.assign(sendReservationTuning, { waitAttempts: 1 });
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
    Object.assign(sendReservationTuning, { waitAttempts: 200, waitDelayMs: 2 });
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

  it("two truly concurrent sends for the SAME inbound never both reach the provider", async () => {
    vi.useRealTimers();
    Object.assign(sendReservationTuning, { waitAttempts: 1 });
    const state = createMockState();
    installSendMock(state);
    // Another sender already holds the conversation lease.
    state.sendReservations = new Map([[CONVERSATION_ID, { holder: "other", expiresAt: Date.now() + 60_000 }]]);
    seedInboundMessage(state, { id: "inbound-r", body: "Hello?" });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-r", "Hello?"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "skipped", reason: "send_reserved_elsewhere" });
    expect(vi.mocked(sendSmsToContact)).not.toHaveBeenCalled();
    expect(state.sendReservations.get(CONVERSATION_ID)?.holder).toBe("other");
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

  it("flags the property when an outbound landed after the claim and the reply is skipped", async () => {
    const state = createMockState();
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-o", body: "Hello?" });
    vi.mocked(generateAiReply).mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-06-13T18:00:02.000Z"));
      state.messages.push({
        id: "tick", body: "tick", channel: "sms", contact_id: CONTACT_ID, conversation_id: CONVERSATION_ID,
        created_at: "2026-06-13T18:00:02+00:00", direction: "outbound", metadata: null, property_id: PROPERTY_ID,
        sent_at: null, status: "sent",
      });
      return HAPPY_REPLY;
    });
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-o", "Hello?"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
    expect(state.property.needs_human_attention).toBe(true);
  });

  it("does not send when another outbound lands in the conversation after the claim", async () => {
    const state = createMockState();
    const supabase = createMockSupabase(state);
    installSendMock(state);
    seedInboundMessage(state, { id: "inbound-c", body: "Hello?" });
    vi.mocked(generateAiReply).mockImplementation(async () => {
      vi.setSystemTime(new Date("2026-06-13T18:00:02.000Z"));
      state.messages.push({
        id: "human-reply",
        body: "Hi, it's Sam",
        channel: "sms",
        contact_id: CONTACT_ID,
        conversation_id: CONVERSATION_ID,
        created_at: new Date().toISOString(),
        direction: "outbound",
        metadata: null,
        property_id: PROPERTY_ID,
        sent_at: new Date().toISOString(),
        status: "sent",
      });
      return HAPPY_REPLY;
    });

    const result = await dispatchAiResponse(supabase as never, input("inbound-c", "Hello?"), { anthropic: {} as never });

    expect(result).toEqual({ outcome: "skipped", reason: "superseded_before_send" });
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

  it("a failed draft write is NOT swallowed: error outcome, claim left retryable, property not flagged, text preserved in the report", async () => {
    const state = createMockState();
    state.config.outbound_mode = "hold";
    state.draftInsertError = { message: "insert boom" };
    installSendMock(state);
    const result = await dispatchAiResponse(createMockSupabase(state) as never, input("inbound-df"), { anthropic: {} as never });
    expect(result).toEqual({ outcome: "escalated", reason: "draft_persist_failed" });
    expect(state.property.needs_human_attention).toBe(false);
    expect(state.aiClaims[0]).toMatchObject({ status: "error", error_message: "draft_persist_failed" });
    expect(reportErrorMock).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: expect.objectContaining({ replyBody: "Hi there" }) }),
    );
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
