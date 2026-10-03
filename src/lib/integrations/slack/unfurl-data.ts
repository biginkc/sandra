import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import {
  SLACK_PREVIEW_TIMEZONE_FALLBACK,
  type SlackLeadPreview,
  type SlackPreviewAttempt,
  type SlackPreviewMessage,
} from "./unfurl-types";

export type {
  SlackLeadPreview,
  SlackLeadPreviewSnapshot,
  SlackPreviewAttempt,
  SlackPreviewMessage,
} from "./unfurl-types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ELIGIBLE_OUTBOUND_STATUSES = "sent,delivered,failed,bounced";

type QueryResult<T> = {
  data: T | null;
  error: { message?: string } | null;
};

type QueryBuilder<T = unknown> = PromiseLike<QueryResult<T>> & {
  select(columns: string): QueryBuilder<T>;
  eq(column: string, value: string): QueryBuilder<T>;
  or(filters: string): QueryBuilder<T>;
  order(column: string, options: { ascending: boolean }): QueryBuilder<T>;
  limit(count: number): QueryBuilder<T>;
  maybeSingle(): Promise<QueryResult<T>>;
};

type PreviewClient = {
  from<T = unknown>(table: string): QueryBuilder<T>;
  auth?: {
    admin?: {
      getUserById(
        userId: string,
      ): Promise<{
        data: { user: {
          email?: string | null;
          app_metadata?: Record<string, unknown>;
        } | null };
        error: { message?: string } | null;
      }>;
    };
  };
};

type PropertyRow = {
  id: string;
  org_id: string;
  address: string | null;
  city: string | null;
  state: string | null;
  homeowner_contact_id: string | null;
  assigned_user_id: string | null;
  outreach_dispo: string | null;
};

type OrganizationRow = {
  id: string;
  name: string | null;
};

type ContactRow = {
  id: string;
  org_id: string;
  first_name: string | null;
  last_name: string | null;
  entity_name: string | null;
};

type MembershipRow = { user_id: string };

type AttemptRow = {
  id: string;
  occurred_at: string;
  outcome: string | null;
};

type MessageRow = {
  id: string;
  created_at: string;
  body: string | null;
  direction: string;
  status: string;
  metadata: unknown;
};

type TimestampRow = {
  id: string;
  created_at: string;
};

function asPreviewClient(client: SupabaseClient<Database>): PreviewClient {
  return client as unknown as PreviewClient;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function displayName(contact: ContactRow | null): string | null {
  if (!contact) return null;
  return clean(
    contact.entity_name ??
      [contact.first_name, contact.last_name].filter(Boolean).join(" "),
  );
}

function propertyAddress(property: PropertyRow): string | null {
  return clean(
    [property.address, property.city, property.state]
      .filter((part): part is string => Boolean(part))
      .join(", "),
  );
}

function attachmentCount(metadata: unknown): number {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return 0;
  }
  const mediaUrls = (metadata as { mediaUrls?: unknown }).mediaUrls;
  return Array.isArray(mediaUrls)
    ? mediaUrls.filter((url) => typeof url === "string" && url.length > 0)
        .length
    : 0;
}

function compareDescending(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number {
  const aTime = Date.parse(a.created_at);
  const bTime = Date.parse(b.created_at);
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) {
    return bTime - aTime;
  }
  return b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id);
}

function latestContactAt(
  message: TimestampRow | null,
  reachedCall: { id: string; occurred_at: string } | null,
): string | null {
  if (!message && !reachedCall) return null;
  if (!message) return reachedCall!.occurred_at;
  if (!reachedCall) return message.created_at;
  return Date.parse(message.created_at) >= Date.parse(reachedCall.occurred_at)
    ? message.created_at
    : reachedCall.occurred_at;
}

async function readOne<T>(
  query: PromiseLike<QueryResult<T>>,
  label: string,
): Promise<T | null> {
  const result = await query;
  if (result.error) throw new Error(`Slack preview ${label}: ${result.error.message ?? "query failed"}`);
  return result.data;
}

async function readMany<T extends readonly unknown[]>(
  query: PromiseLike<QueryResult<T>>,
  label: string,
): Promise<T> {
  const result = await query;
  if (result.error) throw new Error(`Slack preview ${label}: ${result.error.message ?? "query failed"}`);
  return (result.data ?? []) as T;
}

async function loadOwnerName(
  client: PreviewClient,
  orgId: string,
  assignedUserId: string | null,
): Promise<string | null> {
  if (!assignedUserId) return null;

  const membership = await readOne(
    client
      .from<MembershipRow>("memberships")
      .select("user_id")
      .eq("org_id", orgId)
      .eq("user_id", assignedUserId)
      .maybeSingle(),
    "owner membership",
  );
  if (!membership || membership.user_id !== assignedUserId) return null;

  // The service client used by the unfurl worker can resolve exactly the
  // assigned identity. Do not enumerate auth.users or use an email match as
  // an authorization shortcut.
  const admin = client.auth?.admin;
  if (!admin) return null;
  const result = await admin.getUserById(assignedUserId);
  if (result.error || !result.data.user) return null;
  const metadata = result.data.user.app_metadata ?? {};
  const authoritativeName = ["display_name", "full_name", "name"]
    .map((key) => metadata[key])
    .find((value): value is string => typeof value === "string" && Boolean(value.trim()));
  return clean(authoritativeName ?? result.data.user.email);
}

export async function loadPreviewData({
  client,
  orgId,
  propertyId,
}: {
  client: SupabaseClient<Database>;
  orgId: string;
  propertyId: string;
}): Promise<SlackLeadPreview | null> {
  if (!UUID.test(orgId) || !UUID.test(propertyId)) return null;
  const normalizedOrgId = orgId.toLowerCase();
  const normalizedPropertyId = propertyId.toLowerCase();
  const db = asPreviewClient(client);

  const [organization, property] = await Promise.all([
    readOne(
      db
        .from<OrganizationRow>("organizations")
        .select("id, name")
        .eq("id", normalizedOrgId)
        .maybeSingle(),
      "organization",
    ),
    readOne(
      db
        .from<PropertyRow>("properties")
        .select(
          "id, org_id, address, city, state, homeowner_contact_id, assigned_user_id, outreach_dispo",
        )
        .eq("org_id", normalizedOrgId)
        .eq("id", normalizedPropertyId)
        .maybeSingle(),
      "property",
    ),
  ]);

  if (!organization || !property) return null;
  if (
    organization.id !== normalizedOrgId ||
    property.id !== normalizedPropertyId ||
    property.org_id !== normalizedOrgId
  ) {
    return null;
  }

  const contactPromise = property.homeowner_contact_id
    ? readOne(
        db
          .from<ContactRow>("contacts")
          .select("id, org_id, first_name, last_name, entity_name")
          .eq("org_id", normalizedOrgId)
          .eq("id", property.homeowner_contact_id)
          .maybeSingle(),
        "homeowner contact",
      )
    : Promise.resolve(null);

  const ownerPromise = loadOwnerName(
    db,
    normalizedOrgId,
    property.assigned_user_id,
  );

  const messageScope = property.homeowner_contact_id
    ? `property_id.eq.${normalizedPropertyId},and(property_id.is.null,contact_id.eq.${property.homeowner_contact_id})`
    : `property_id.eq.${normalizedPropertyId}`;

  const messagesPromise = readMany<MessageRow[]>(
    db
      .from<MessageRow[]>("messages")
      .select("id, created_at, body, direction, status, metadata")
      .eq("org_id", normalizedOrgId)
      .eq("channel", "sms")
      .or(
        `direction.eq.inbound,and(direction.eq.outbound,status.in.(${ELIGIBLE_OUTBOUND_STATUSES}))`,
      )
      .or(messageScope)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(3),
    "latest messages",
  );

  // This second SMS read intentionally excludes failed/bounced outbound
  // messages: they remain visible in the strip but are not contact evidence.
  const successfulMessagePromise = readOne(
    db
      .from<TimestampRow>("messages")
      .select("id, created_at")
      .eq("org_id", normalizedOrgId)
      .eq("channel", "sms")
      .or("direction.eq.inbound,and(direction.eq.outbound,status.in.(sent,delivered))")
      .or(messageScope)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "last successful SMS",
  );

  const latestAttemptPromise = readOne(
    db
      .from<AttemptRow>("acquisition_attempts")
      .select("id, occurred_at, outcome")
      .eq("org_id", normalizedOrgId)
      .eq("property_id", normalizedPropertyId)
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "latest attempt",
  );

  const reachedCallPromise = readOne(
    db
      .from<{ id: string; occurred_at: string }>("acquisition_attempts")
      .select("id, occurred_at")
      .eq("org_id", normalizedOrgId)
      .eq("property_id", normalizedPropertyId)
      .eq("attempt_kind", "call")
      .eq("outcome", "reached")
      .order("occurred_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "last reached call",
  );

  const [contact, ownerName, messageRows, successfulMessage, latestAttempt, reachedCall] =
    await Promise.all([
      contactPromise,
      ownerPromise,
      messagesPromise,
      successfulMessagePromise,
      latestAttemptPromise,
      reachedCallPromise,
    ]);

  const scopedContact =
    contact &&
    contact.id === property.homeowner_contact_id &&
    contact.org_id === normalizedOrgId
      ? contact
      : null;

  const messages = messageRows
    .filter(
      (message): message is MessageRow =>
        typeof message.id === "string" &&
        typeof message.created_at === "string" &&
        (message.direction === "inbound" || message.direction === "outbound"),
    )
    .sort(compareDescending)
    .slice(0, 3)
    .reverse()
    .map((message) => ({
      id: message.id,
      createdAt: message.created_at,
      body: message.body ?? "",
      direction: message.direction as SlackPreviewMessage["direction"],
      deliveryStatus: message.status,
      attachmentCount: attachmentCount(message.metadata),
    } satisfies SlackPreviewMessage));

  const attempt: SlackPreviewAttempt | null = latestAttempt
    ? {
        id: latestAttempt.id,
        occurredAt: latestAttempt.occurred_at,
        outcome: latestAttempt.outcome,
      }
    : null;

  return {
    propertyId: normalizedPropertyId,
    leadName: displayName(scopedContact),
    address: propertyAddress(property),
    ownerName,
    ownerAssigned: Boolean(property.assigned_user_id),
    latestAttempt: attempt,
    messagesDisposition: clean(property.outreach_dispo),
    lastContactAt: latestContactAt(successfulMessage, reachedCall),
    // organizations currently has no timezone column; keep this explicit
    // rather than reading a per-user preference as if it were org metadata.
    timezone: SLACK_PREVIEW_TIMEZONE_FALLBACK,
    messages,
  };
}
