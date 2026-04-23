"use client";

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

      await fetchCount();

      // Safety-net poll — low-frequency, catches rare socket drops.
      pollId = setInterval(fetchCount, 15000);
    };

    void start();

    return () => {
      mounted = false;
      if (pollId) clearInterval(pollId);
      if (channel) void supabase.removeChannel(channel);
    };
  }, [userId]);

  const loadItems = async () => {
    const r = await getRecentNotifications(10);
    if (r.ok) setItems(r.data);
    setLoaded(true);
  };

  const hrefFor = (n: NotificationRow): string => {
    if (n.entityType === "property") return `/leads/${n.entityId}`;
    if (n.entityType === "job") return `/jobs`;
    return "/";
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
    router.push(hrefFor(n));
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
            className="relative"
            data-testid="notifications-bell"
          >
            <Bell className="h-5 w-5" />
            {unreadCount > 0 && (
              <span
                data-testid="notifications-badge"
                className="bg-destructive text-destructive-foreground absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold"
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
                <div className="text-sm font-medium">{n.title}</div>
                {n.body && (
                  <div className="text-muted-foreground mt-0.5 text-xs">
                    {n.body}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}

        {loaded && anyUnread && (
          <button
            onClick={() => void onMarkAll()}
            className="text-muted-foreground hover:bg-accent hover:text-foreground w-full border-t px-3 py-2 text-left text-xs"
            data-testid="notifications-mark-all-read"
          >
            Mark all as read
          </button>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
