"use client";

import Link from "next/link";
import { Home } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import type { HomeownerHouses } from "@/lib/leads/homeowner-houses";
import { cn } from "@/lib/utils";

// Same shape as the My Leads stage pill (the boldest badge on the row), in the brand indigo.
const BADGE_CLASSES =
  "h-auto min-h-6 cursor-pointer rounded-md border border-indigo-300 bg-indigo-100 px-2 py-[3px] text-[11px] font-extrabold tracking-wide text-indigo-900 uppercase hover:bg-indigo-200 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900";

/**
 * "Owns N houses" next to a homeowner's name. Hidden unless the homeowner owns 2+ houses in the org.
 * Tapping it lists every address; each opens its lead. A house assigned to someone else is labelled
 * "another rep's lead"; opening it follows the lead page's own permissions.
 */
export function MultiHouseBadge({
  houses,
  ownerName,
  currentPropertyId,
  className,
  testId = "multi-house-badge",
}: {
  houses: HomeownerHouses | null | undefined;
  ownerName?: string | null;
  /** The lead being viewed; marked "This lead" in the list. */
  currentPropertyId?: string;
  className?: string;
  testId?: string;
}) {
  if (!houses || houses.count < 2) return null;
  const label = `Owns ${houses.count} houses`;
  const who = ownerName?.trim() || "This homeowner";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Badge
            render={<button type="button" />}
            className={cn(BADGE_CLASSES, className)}
            aria-label={`${label}. Show ${who}'s houses`}
            data-testid={testId}
          />
        }
        onClick={(event) => event.stopPropagation()}
      >
        <Home aria-hidden="true" />
        {label}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(20rem,calc(100vw-2rem))] text-foreground"
        data-testid={`${testId}-list`}
        onClick={(event) => event.stopPropagation()}
      >
        <PopoverTitle className="text-[13px] font-bold">
          {who} owns {houses.count} houses
        </PopoverTitle>
        <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label={`${who}'s houses`}>
          {houses.houses.map((house) => {
            const current = house.propertyId === currentPropertyId;
            const note = current ? "This lead" : house.isMine ? null : house.assignedUserId ? "another rep's lead" : "unassigned";
            return (
              <li key={house.propertyId}>
                <Link
                  href={`/leads/${house.propertyId}`}
                  aria-current={current ? "page" : undefined}
                  className="block rounded-md px-2 py-2 text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid={`${testId}-house-${house.propertyId}`}
                >
                  <span className="block break-words font-semibold">{house.address}</span>
                  {note && <span className="block text-[11.5px] text-muted-foreground">{note}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
        {houses.houses.length < houses.count && (
          <p className="px-2 text-[11.5px] text-muted-foreground">
            Showing {houses.houses.length} of {houses.count}.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}
