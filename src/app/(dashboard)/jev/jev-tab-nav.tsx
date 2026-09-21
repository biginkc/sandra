"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

const TABS = [
  { href: "/jev/needs-decision", label: "Needs a decision" },
  { href: "/jev/review", label: "Review Jev" },
] as const;

export function JevTabNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Jev" className="flex gap-1 border-b px-4 md:px-6">
      {TABS.map((tab) => {
        const active = pathname === tab.href || pathname.startsWith(tab.href + "/");
        return (
          <Link
            key={tab.href}
            href={tab.href}
            data-active={active || undefined}
            className={cn(
              "border-b-2 px-3 py-3 text-sm font-semibold transition-colors",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
