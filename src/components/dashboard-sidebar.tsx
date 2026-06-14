"use client";

import {
  Briefcase,
  Download,
  FileText,
  Gauge,
  LayoutDashboard,
  List,
  MessageSquare,
  Repeat,
  Target,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * Left-nav for the dashboard — the day-to-day workflow ladder. Admin /
 * config links (Team, Webhooks, AI responder) live in the top nav
 * (`DashboardAdminNav`), not here, so the sidebar stays uncluttered.
 * Pathname-reactive (hover + active-link highlighting), so it must be
 * client-side.
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
  { href: "/templates", label: "Templates", icon: FileText },
  { href: "/messages", label: "Messages", icon: MessageSquare },
  { href: "/leads", label: "Leads", icon: LayoutDashboard },
  { href: "/jobs", label: "Jobs", icon: Briefcase },
];

const ITEM_BASE =
  "flex items-center gap-3 py-3 text-sm font-bold tracking-[0.02em] transition-all duration-150 ease-in-out";
const ITEM_ACTIVE =
  "border-l-4 border-nav-active-border bg-white/10 pl-[17px] text-white";
const ITEM_INACTIVE =
  "pl-[21px] text-white/75 hover:bg-white/[0.07] hover:text-white";

const MOBILE_ITEM_BASE =
  "rounded-full border border-white/10 px-3 py-1.5 text-xs font-bold tracking-[0.02em] whitespace-nowrap transition-colors duration-150 ease-in-out";
const MOBILE_ITEM_ACTIVE =
  "border-nav-active-border bg-white/10 text-white";
const MOBILE_ITEM_INACTIVE = "text-white/75 hover:bg-white/[0.07] hover:text-white";

export function DashboardSidebar() {
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
    </nav>
  );
}

export function DashboardMobileNav() {
  const pathname = usePathname();

  const isActiveHref = (href: string): boolean =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    <nav
      aria-label="Primary"
      className="flex items-center gap-2 overflow-x-auto px-4 py-3"
    >
      {ITEMS.map((item) => {
        const active = isActiveHref(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            data-active={active || undefined}
            className={cn(
              MOBILE_ITEM_BASE,
              active ? MOBILE_ITEM_ACTIVE : MOBILE_ITEM_INACTIVE,
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
