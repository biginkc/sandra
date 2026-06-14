"use client";

import { Bot, Link as LinkIcon, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * Admin links for the top nav. Rendered in the dashboard header (left
 * side, before the notifications bell) only for admins. Pulled out of
 * the left sidebar (`DashboardSidebar`) so the left nav stays focused on
 * the day-to-day workflow ladder; the lower-traffic admin/config pages
 * (Team, Webhooks, AI responder) live up top instead.
 *
 * Responsive: icon + label on md+, icon-only on mobile (matching the
 * bell's icon-only top-nav treatment, and so the row fits next to the
 * logo + controls). Pathname-reactive active state, so this must be a
 * client component.
 *
 * Semantic: `<nav aria-label="Admin">` — deliberately distinct from the
 * Primary nav so existing `nav[aria-label="Primary"]` selectors (e.g.
 * sequences-flows.spec.ts) are unaffected. `aria-label` on each link
 * keeps an accessible name even when the visible label is hidden on
 * mobile.
 */

type AdminItem = {
  href: string;
  label: string;
  icon: typeof Users;
};

const ADMIN_ITEMS: readonly AdminItem[] = [
  { href: "/admin/users", label: "Team", icon: Users },
  { href: "/admin/webhooks", label: "Webhooks", icon: LinkIcon },
  { href: "/settings/ai-responder", label: "AI responder", icon: Bot },
];

const ITEM_BASE =
  "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold tracking-[0.02em] transition-colors duration-150 ease-in-out";
const ITEM_ACTIVE = "border-nav-active-border bg-white/10 text-white";
const ITEM_INACTIVE =
  "border-transparent text-white/75 hover:bg-white/[0.07] hover:text-white";

export function DashboardAdminNav({ showAdmin }: { showAdmin: boolean }) {
  const pathname = usePathname();
  if (!showAdmin) return null;

  const isActive = (href: string): boolean =>
    pathname === href || pathname.startsWith(href + "/");

  return (
    <nav aria-label="Admin" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {ADMIN_ITEMS.map((item) => {
        const active = isActive(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-label={item.label}
            data-active={active || undefined}
            className={cn(ITEM_BASE, active ? ITEM_ACTIVE : ITEM_INACTIVE)}
          >
            <Icon className="size-5 shrink-0" aria-hidden />
            <span className="hidden md:inline">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
