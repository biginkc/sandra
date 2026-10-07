/**
 * What the replay export carries, table by table. Used by BOTH export and seed
 * so the column lists cannot drift. Columns not listed here are deliberately
 * left out: generated/search columns, provider ids that could point back at
 * real records, assignee/auth ids, and anything the replay recomputes itself.
 */

export type ReplayTable =
  | "contacts"
  | "properties"
  | "property_contacts"
  | "message_threads"
  | "messages"
  | "sms_phone_suppressions"
  | "consent_events"
  | "ai_responder_configs"
  | "jev_outcome_thresholds";

export type TableSpec = {
  columns: readonly string[];
  /** Seller phone columns: replaced with the deterministic masked number. */
  phoneColumns?: readonly string[];
  /** Columns that must not be run through free-text phone scrubbing (ids etc.). */
  rawColumns?: readonly string[];
  /** Columns forced to null in the replay copy (auth/user ids, provider handles). */
  nullColumns?: readonly string[];
  /** Table may be absent from older databases; skipped when `to_regclass` is null. */
  optional?: boolean;
};

export const TABLES: Record<ReplayTable, TableSpec> = {
  contacts: {
    columns: [
      "id", "org_id", "contact_type", "first_name", "last_name", "entity_name",
      "phone_1", "phone_1_type", "phone_2", "phone_2_type", "phone_3", "phone_3_type",
      "do_not_contact", "sms_opted_out", "sms_opted_out_at", "notes", "created_at",
    ],
    phoneColumns: ["phone_1", "phone_2", "phone_3"],
    rawColumns: ["id", "org_id", "contact_type", "phone_1_type", "phone_2_type", "phone_3_type"],
  },
  properties: {
    columns: [
      "id", "org_id", "address", "address_normalized", "city", "state", "zip", "status",
      "outreach_dispo", "needs_human_attention", "ai_responder_disabled", "follow_up_at",
      "source", "motivation_level", "notes", "beds", "baths", "sqft", "year_built", "arv",
      "listing_price", "mortgage_balance", "equity_estimate", "lat", "lon", "deleted_at",
      "homeowner_contact_id", "created_at", "updated_at",
    ],
    rawColumns: ["id", "org_id", "zip", "status", "outreach_dispo", "homeowner_contact_id", "source"],
  },
  property_contacts: {
    columns: ["property_id", "contact_id", "org_id", "relationship", "source_identity", "source_position", "source_attributes"],
    rawColumns: ["property_id", "contact_id", "org_id", "relationship", "source_identity"],
  },
  message_threads: {
    columns: ["id", "org_id", "conversation_id", "contact_id", "property_id", "channel", "created_at", "updated_at"],
    rawColumns: ["id", "org_id", "conversation_id", "contact_id", "property_id", "channel"],
  },
  messages: {
    columns: [
      "id", "org_id", "conversation_id", "contact_id", "property_id", "channel", "direction",
      "body", "status", "provider", "external_id", "from_address", "to_address", "created_at",
      "sent_at", "delivered_at", "read_at", "metadata",
    ],
    phoneColumns: ["from_address", "to_address"],
    rawColumns: ["id", "org_id", "conversation_id", "contact_id", "property_id", "channel", "direction", "status", "provider", "external_id"],
  },
  sms_phone_suppressions: {
    columns: ["id", "org_id", "phone_e164", "source", "source_detail", "provider", "suppressed_at", "created_at", "updated_at"],
    phoneColumns: ["phone_e164"],
    rawColumns: ["id", "org_id", "source", "provider"],
    nullColumns: ["first_contact_id"],
  },
  consent_events: {
    columns: ["id", "org_id", "contact_id", "channel", "event_type", "source", "source_detail", "idempotency_key", "occurred_at", "created_at"],
    rawColumns: ["id", "org_id", "contact_id", "channel", "event_type", "source", "idempotency_key"],
  },
  ai_responder_configs: {
    columns: [
      "id", "org_id", "active", "business_hours_only", "classifier_fallback_max_consecutive",
      "classifier_mode", "classifier_provider", "escalation_keywords", "max_turns", "min_confidence",
      "model", "outbound_mode", "reply_delay_max_seconds", "reply_delay_min_seconds", "system_prompt",
      "created_at", "updated_at",
    ],
    rawColumns: ["id", "org_id", "classifier_mode", "classifier_provider", "model", "outbound_mode"],
    optional: true,
  },
  jev_outcome_thresholds: {
    columns: ["id", "org_id", "outcome", "min_confidence", "automation_enabled", "version", "updated_at"],
    rawColumns: ["id", "org_id", "outcome"],
    optional: true,
  },
};

/** Seed order (parents first). */
export const SEED_ORDER: readonly ReplayTable[] = [
  "contacts",
  "properties",
  "property_contacts",
  "message_threads",
  "messages",
  "sms_phone_suppressions",
  "consent_events",
  "ai_responder_configs",
  "jev_outcome_thresholds",
];

export type ReplayInbound = {
  id: string;
  externalId: string;
  from: string;
  to: string;
  body: string;
  receivedAt: string;
  contactId: string | null;
  propertyId: string | null;
  conversationId: string | null;
};

export type ReplayExport = {
  version: 1;
  batchId: string;
  createdAt: string;
  sourceOrgId: string;
  window: { start: string; end: string; days: number; contextDays: number };
  businessNumbers: string[];
  tables: Record<ReplayTable, Record<string, unknown>[]>;
  inbound: ReplayInbound[];
  reference: {
    pipelineRuns: Record<string, unknown>[];
    outboundInWindow: Record<string, unknown>[];
    /** Production Jev runs and later human decisions; used only by replay:compare. Absent in older exports. */
    humanEvents?: {
      runs: Record<string, unknown>[];
      reviews: Record<string, unknown>[];
      decisions: Record<string, unknown>[];
      dispoSets: Record<string, unknown>[];
    };
  };
  counts: Record<string, number>;
};

export type Query = (
  sql: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;
