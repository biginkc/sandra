"use client";

import { formatDistanceToNowStrict } from "date-fns/formatDistanceToNowStrict";
import { Bell } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  clearAllNotifications,
  getRecentNotifications,
  getUnreadCount,
  markAllRead,
  markRead,
  type NotificationRow,
} from "@/app/(dashboard)/_actions/notifications";
import { createClient } from "@/lib/supabase/client";

/**
 * Top-nav bell icon with unread counter + recent-notifications dropdown.
 *
 * Realtime primary, 15s safety-net poll — mirrors the pattern from
 * `src/app/(dashboard)/import/steps/step-progress.tsx:43-86`, including
 * the April 2026 auth-race fix (`supabase.realtime.setAuth()` MUST
 * resolve before `.subscribe()` or the socket opens as anon and RLS
 * silently drops every event).
 *
 * The dropdown lazy-loads its contents on first open — the badge only
 * needs the unread count, which comes through Realtime + poll without
 * loading rows.
 */
export function NotificationsBell({ userId }: { userId: string }) {
  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;
    let pollId: ReturnType<typeof setInterval> | null = null;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    const fetchCount = async () => {
      const r = await getUnreadCount();
      if (!mounted) return;
      if (r.ok) setUnreadCount(r.data);
    };

    const fetchCountIfVisible = async () => {
      if (document.visibilityState === "visible") {
        await fetchCount();
      }
    };
    document.addEventListener("visibilitychange", fetchCountIfVisible);

    const start = async () => {
      // Must await setAuth() BEFORE subscribing — same race as
      // step-progress.tsx. Token resolves to the current session's access
      // JWT; subscribing as anon means RLS drops every event.
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token ?? null;
      if (token) supabase.realtime.setAuth(token);
      if (!mounted) return;

      channel = supabase
        .channel(`notifications:${userId}`)
        .on(
          "postgres_changes",
          {
            event: "INSERT",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${userId}`,
          },
          () => {
            if (mounted) setUnreadCount((n) => n + 1);
          },
        )
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "notifications",
            filter: `user_id=eq.${userId}`,
          },
          (payload) => {
            // Decrement only when read_at transitions null → not-null.
            const next = payload.new as { read_at: string | null };
            const prev = payload.old as { read_at: string | null };
            if (mounted && next.read_at && !prev.read_at) {
              setUnreadCount((n) => Math.max(0, n - 1));
            }
          },
        )
        .subscribe();

      await fetchCountIfVisible();

      // Safety-net poll — low-frequency, catches rare socket drops.
      pollId = setInterval(fetchCountIfVisible, 15000);
    };

    void start();

    return () => {
      mounted = false;
      if (pollId) clearInterval(pollId);
      document.removeEventListener("visibilitychange", fetchCountIfVisible);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId]);

  const loadItems = async () => {
    const r = await getRecentNotifications(10);
    if (r.ok) setItems(r.data);
    setLoaded(true);
  };

  const onNotificationClick = async (n: NotificationRow) => {
    // Optimistically mark read; if the server write fails the Realtime
    // UPDATE won't land and the next poll will correct the badge.
    if (!n.readAt) {
      setUnreadCount((c) => Math.max(0, c - 1));
      const nowIso = new Date().toISOString();
      setItems((curr) =>
        curr.map((x) => (x.id === n.id ? { ...x, readAt: nowIso } : x)),
      );
      await markRead(n.id);
    }
    router.push(n.href);
  };

  const onMarkAll = async () => {
    setUnreadCount(0);
    setItems((curr) =>
      curr.map((x) =>
        x.readAt ? x : { ...x, readAt: new Date().toISOString() },
      ),
    );
    await markAllRead();
  };

  const onClearAll = async () => {
    // Hard-delete: notifications are ephemeral, no audit value in
    // retaining cleared rows. Optimistically empty + drop the badge so
    // the dropdown reads "all caught up" instantly; if the server fails
    // the next poll reconciles.
    setUnreadCount(0);
    setItems([]);
    await clearAllNotifications();
  };

  const anyUnread = items.some((n) => !n.readAt);

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open && !loaded) void loadItems();
      }}
    >
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Notifications"
            className="relative size-[38px] rounded-full text-white hover:bg-white/[0.07] hover:text-white"
            data-testid="notifications-bell"
          >
            <Bell className="size-[19px]" />
            {unreadCount > 0 && (
              <span
                data-testid="notifications-badge"
                className="bg-destructive absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-80 p-0">
        <div className="border-border border-b px-3 py-2 text-sm font-semibold">
          Notifications
        </div>

        {!loaded && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            Loading…
          </div>
        )}

        {loaded && items.length === 0 && (
          <div className="text-muted-foreground px-3 py-4 text-sm">
            You&rsquo;re all caught up.
          </div>
        )}

        {loaded && items.length > 0 && (
          <div className="max-h-96 overflow-y-auto">
            {items.map((n) => (
              <button
                key={n.id}
                onClick={() => void onNotificationClick(n)}
                className={`hover:bg-accent block w-full border-b px-3 py-2 text-left last:border-b-0 ${
                  !n.readAt ? "bg-accent/40" : ""
                }`}
                data-testid={`notifications-item-${n.id}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium">{n.title}</div>
                  <time
                    dateTime={n.createdAt}
                    className="text-muted-foreground shrink-0 text-[10px] uppercase tracking-wide"
                    data-testid={`notifications-item-time-${n.id}`}
                  >
                    {formatDistanceToNowStrict(new Date(n.createdAt), {
                      addSuffix: true,
                    })}
                  </time>
                </div>
                {n.body && (
                  <div className="text-muted-foreground mt-0.5 text-xs">
                    {n.body}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}

        {loaded && items.length > 0 && (
          <div className="flex border-t">
            {anyUnread && (
              <button
                onClick={() => void onMarkAll()}
                className="text-muted-foreground hover:bg-accent hover:text-foreground flex-1 px-3 py-2 text-left text-xs"
                data-testid="notifications-mark-all-read"
              >
                Mark all as read
              </button>
            )}
            <button
              onClick={() => void onClearAll()}
              className="text-muted-foreground hover:bg-accent hover:text-foreground flex-1 border-l px-3 py-2 text-right text-xs first:border-l-0 first:text-left"
              data-testid="notifications-clear-all"
            >
              Clear all
            </button>
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
