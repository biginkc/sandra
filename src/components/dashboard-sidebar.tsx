"use client";

import {
  Bot,
  Briefcase,
  Download,
  LayoutDashboard,
  List,
  MessageSquare,
  Repeat,
  Target,
  Users,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * Left-nav for the dashboard. Server component (`layout.tsx`) passes
 * `showAdmin` so we render the Team link only for admins; the rest is
 * pathname-reactive (useful hover + active-link highlighting), which
 * needs to be client-side.
 */

type Item = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** A link matches when pathname startsWith either `href` OR any `matchAlso` entry. */
  matchAlso?: readonly string[];
};

const ITEMS: readonly Item[] = [
  { href: "/leads", label: "Leads", icon: LayoutDashboard },
  { href: "/properties", label: "Prospects", icon: Target },
  { href: "/lists", label: "Lists", icon: List },
  { href: "/sequences", label: "Sequences", icon: Repeat },
  { href: "/import", label: "Import", icon: Download },
  { href: "/messages", label: "Messages", icon: MessageSquare },
  { href: "/jobs", label: "Jobs", icon: Briefcase },
];

export function DashboardSidebar({ showAdmin }: { showAdmin: boolean }) {
  const pathname = usePathname();

  const isActive = (item: Item): boolean => {
    if (pathname === item.href) return true;
    if (pathname.startsWith(item.href + "/")) return true;
    for (const extra of item.matchAlso ?? []) {
      if (pathname === extra || pathname.startsWith(extra + "/")) return true;
    }
    return false;
  };

  return (
    <nav
      aria-label="Primary"
      className="flex flex-1 flex-col gap-0.5 p-2 text-sm"
    >
      {ITEMS.map((item) => {
        const active = isActive(item);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            data-active={active || undefined}
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors",
              active
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Icon className="h-4 w-4" aria-hidden />
            <span>{item.label}</span>
          </Link>
        );
      })}
      {showAdmin && (
        <>
          <Link
            href="/admin/users"
            data-active={
              pathname === "/admin/users" ||
              pathname.startsWith("/admin/users/") ||
              undefined
            }
            className={cn(
              "mt-2 flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors",
              pathname === "/admin/users" ||
                pathname.startsWith("/admin/users/")
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Users className="h-4 w-4" aria-hidden />
            <span>Team</span>
          </Link>
          <Link
            href="/settings/ai-responder"
            data-active={
              pathname === "/settings/ai-responder" ||
              pathname.startsWith("/settings/ai-responder/") ||
              undefined
            }
            className={cn(
              "flex items-center gap-2 rounded-md px-3 py-1.5 transition-colors",
              pathname === "/settings/ai-responder" ||
                pathname.startsWith("/settings/ai-responder/")
                ? "bg-accent text-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
          >
            <Bot className="h-4 w-4" aria-hidden />
            <span>AI responder</span>
          </Link>
        </>
      )}
    </nav>
  );
}
