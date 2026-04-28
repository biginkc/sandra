"use client";

import {
  Bot,
  Briefcase,
  Download,
  Gauge,
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
 *
 * Visual contract — design refresh: each item is a 3-unit-tall row
 * with a 4px left-border accent for the active state (replaces the
 * older accent-bg pill). The semantic structure is unchanged so the
 * `nav[aria-label="Primary"]` + link-by-name selectors used in
 * sequences-flows.spec.ts continue to work without edits.
 */

type Item = {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /** A link matches when pathname startsWith either `href` OR any `matchAlso` entry. */
  matchAlso?: readonly string[];
};

// Overview is the morning-triage landing page (KPIs + needs-attention).
// Below it, the workflow ladder: data arrives (Import) → sits in the raw
// pool (Prospects) → gets segmented into outreach targets (Lists) → drips
// run against them (Sequences) → replies land in the cockpit (Messages) →
// engaged records become qualified pipeline (Leads). Jobs is the system
// plumbing footer.
const ITEMS: readonly Item[] = [
  { href: "/dashboard", label: "Overview", icon: Gauge },
  { href: "/import", label: "Import", icon: Download },
  { href: "/properties", label: "Prospects", icon: Target },
  { href: "/lists", label: "Lists", icon: List },
  { href: "/sequences", label: "Sequences", icon: Repeat },
  { href: "/messages", label: "Messages", icon: MessageSquare },
  { href: "/leads", label: "Leads", icon: LayoutDashboard },
  { href: "/jobs", label: "Jobs", icon: Briefcase },
];

const ITEM_BASE =
  "flex items-center gap-3 py-3 text-sm font-bold tracking-wide transition-all duration-200 ease-in-out";
const ITEM_ACTIVE =
  "text-foreground border-l-4 border-foreground pl-4";
const ITEM_INACTIVE =
  "text-muted-foreground hover:bg-muted hover:text-foreground pl-5";

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

  const adminUsersActive =
    pathname === "/admin/users" || pathname.startsWith("/admin/users/");
  const adminAiActive =
    pathname === "/settings/ai-responder" ||
    pathname.startsWith("/settings/ai-responder/");

  return (
    <nav aria-label="Primary" className="flex flex-1 flex-col gap-1">
      {ITEMS.map((item) => {
        const active = isActive(item);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            data-active={active || undefined}
            className={cn(ITEM_BASE, active ? ITEM_ACTIVE : ITEM_INACTIVE)}
          >
            <Icon className="size-5" aria-hidden />
            <span>{item.label}</span>
          </Link>
        );
      })}
      {showAdmin && (
        <>
          <Link
            href="/admin/users"
            data-active={adminUsersActive || undefined}
            className={cn(
              ITEM_BASE,
              "mt-2",
              adminUsersActive ? ITEM_ACTIVE : ITEM_INACTIVE,
            )}
          >
            <Users className="size-5" aria-hidden />
            <span>Team</span>
          </Link>
          <Link
            href="/settings/ai-responder"
            data-active={adminAiActive || undefined}
            className={cn(ITEM_BASE, adminAiActive ? ITEM_ACTIVE : ITEM_INACTIVE)}
          >
            <Bot className="size-5" aria-hidden />
            <span>AI responder</span>
          </Link>
        </>
      )}
    </nav>
  );
}
