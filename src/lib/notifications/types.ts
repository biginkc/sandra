/**
 * Shared types for the notifications subsystem. Matches the shape of the
 * `notifications` table (migration 016) plus the payload contracts
 * between dispatch hook points and the format layer.
 */

export type EventType =
  | "owner_message_added"
  | "property_assigned"
  | "bulk_action_completed"
  | "skip_trace_requested"
  | "task_assigned"
  | "ai_responder_provider_failure";

export type EntityType = "property" | "job" | "task" | "message";

/**
 * One row in the `notifications` table. `camelCase` for app-layer
 * ergonomics; DB rows come off `supabase` in `snake_case` and are mapped
 * at read sites.
 */
type Notification = {
  id: string;
  orgId: string;
  userId: string;
  eventType: EventType;
  entityType: EntityType;
  entityId: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
};

/**
 * Single loose-typed payload covering all event types. Fields are
 * optional because each event only uses a subset. `formatNotification`
 * is defensive about missing values (test #4) so this looseness is
 * intentional — avoids a discriminated union at every call site.
 */
export type FormatPayload = {
  propertyAddress?: string | null;
  needsPropertyTriage?: boolean;
  assignerName?: string | null;
  jobType?: string | null;
  state?: string | null;
  succeeded?: number;
  failed?: number;
  /** For skip_trace_requested: who asked + how many properties. */
  requesterEmail?: string | null;
  propertyCount?: number;
  /** For owner_message_added: the inbound SMS body to preview. */
  messageBody?: string | null;
  /** For task_assigned: the task title (e.g., "Follow up on 123 Main St"). */
  taskTitle?: string;
  /** For task_assigned: 'follow_up' | 'callback' | 'custom'. */
  taskType?: string;
  /** For task_assigned: ISO timestamptz of due_at. */
  dueAt?: string;
  /** For ai_responder_provider_failure: which account-level failure. */
  providerFailure?: "billing" | "auth";
};
