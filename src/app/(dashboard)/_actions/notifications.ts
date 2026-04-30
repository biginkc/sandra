"use server";

import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { reportError } from "@/lib/errors/report";

/**
 * Shape the bell UI actually renders. Column names are camelCased and
 * types are narrowed from the permissive `text` DB columns to the three
 * known enums so the UI can switch on them safely.
 */
export type NotificationRow = {
  id: string;
  eventType:
    | "owner_message_added"
    | "property_assigned"
    | "bulk_action_completed";
  entityType: "property" | "job";
  entityId: string;
  title: string;
  body: string | null;
  readAt: string | null;
  createdAt: string;
};

/** Count of unread notifications for the current user. Drives the badge. */
export async function getUnreadCount(): Promise<Result<number>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return ok(0);

    const { count, error } = await supabase
      .from("notifications")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .is("read_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "NOTIF_COUNT_FAILED", message: error.message },
      };
    }
    return ok(count ?? 0);
  } catch (e) {
    reportError(e, { tags: { surface: "get_unread_count" } });
    return errFromUnknown(e, "NOTIF_COUNT_FAILED");
  }
}

/**
 * Most-recent notifications for the current user, capped at `limit`.
 * Drives the dropdown body. Returned newest-first. Includes both read
 * and unread; the UI dims read rows.
 */
export async function getRecentNotifications(
  limit = 10,
): Promise<Result<NotificationRow[]>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return ok([]);

    const { data, error } = await supabase
      .from("notifications")
      .select(
        "id, event_type, entity_type, entity_id, title, body, read_at, created_at",
      )
      .eq("user_id", user.id)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error) {
      return {
        ok: false,
        error: { code: "NOTIF_LIST_FAILED", message: error.message },
      };
    }
    const rows: NotificationRow[] = (data ?? []).map((r) => ({
      id: r.id,
      eventType: r.event_type as NotificationRow["eventType"],
      entityType: r.entity_type as NotificationRow["entityType"],
      entityId: r.entity_id,
      title: r.title,
      body: r.body,
      readAt: r.read_at,
      createdAt: r.created_at,
    }));
    return ok(rows);
  } catch (e) {
    reportError(e, { tags: { surface: "get_recent_notifications" } });
    return errFromUnknown(e, "NOTIF_LIST_FAILED");
  }
}

/**
 * Flip a single notification to read. Scoped to the current user so a
 * stray id from one account can't clear another's notification.
 */
export async function markRead(
  notificationId: string,
): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in." },
      };
    }
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("id", notificationId)
      .eq("user_id", user.id)
      .is("read_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "MARK_READ_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, {
      tags: { surface: "notifications_mark_read" },
      extra: { notificationId },
    });
    return errFromUnknown(e, "MARK_READ_FAILED");
  }
}

/** Clear the badge in one shot. */
export async function markAllRead(): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in." },
      };
    }
    const { error } = await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("user_id", user.id)
      .is("read_at", null);
    if (error) {
      return {
        ok: false,
        error: { code: "MARK_ALL_READ_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "notifications_mark_all_read" } });
    return errFromUnknown(e, "MARK_ALL_READ_FAILED");
  }
}

/**
 * Hard-delete every notification for the current user. Notifications are
 * ephemeral signals, not audit records — there's no value in retaining
 * "cleared" rows. Both the dropdown and the unread badge fall to zero.
 *
 * Scoped to the authenticated user via `user_id` filter; RLS on the
 * notifications table provides defense in depth.
 */
export async function clearAllNotifications(): Promise<Result<null>> {
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return {
        ok: false,
        error: { code: "UNAUTHENTICATED", message: "Not signed in." },
      };
    }
    const { error } = await supabase
      .from("notifications")
      .delete()
      .eq("user_id", user.id);
    if (error) {
      return {
        ok: false,
        error: { code: "CLEAR_ALL_FAILED", message: error.message },
      };
    }
    return ok(null);
  } catch (e) {
    reportError(e, { tags: { surface: "notifications_clear_all" } });
    return errFromUnknown(e, "CLEAR_ALL_FAILED");
  }
}
