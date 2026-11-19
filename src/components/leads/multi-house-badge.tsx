"use client";

import Link from "next/link";
import { Home } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import type { HomeownerHouse, HomeownerHouses } from "@/lib/leads/homeowner-houses";
import { loadMoreHomeownerHousesAction } from "@/lib/leads/homeowner-houses-action";
import { cn } from "@/lib/utils";

// Same shape as the My Leads stage pill (the boldest badge on the row), in the brand indigo.
const BADGE_CLASSES =
  "h-auto min-h-6 cursor-pointer rounded-md border border-indigo-300 bg-indigo-100 px-2 py-[3px] text-[11px] font-extrabold tracking-wide text-indigo-900 uppercase hover:bg-indigo-200 dark:border-indigo-700 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900";

/**
 * "Owns N houses" next to a homeowner's name. Hidden unless the homeowner owns 2+ houses in the org.
 * Tapping it lists every address; each opens its lead. A house assigned to someone else is labelled
 * "another rep's lead"; opening it follows the lead page's own permissions. Past the first page, "Show more"
 * loads the rest (needs contactId).
 */
export function MultiHouseBadge({
  houses,
  contactId,
  ownerName,
  currentPropertyId,
  className,
  testId = "multi-house-badge",
}: {
  houses: HomeownerHouses | null | undefined;
  /** The homeowner contact; lets "Show more" load houses past the first page. */
  contactId?: string | null;
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
        <HouseList key={contactId ?? "none"} houses={houses} contactId={contactId ?? null} who={who} currentPropertyId={currentPropertyId} testId={testId} />
      </PopoverContent>
    </Popover>
  );
}

function HouseList({
  houses,
  contactId,
  who,
  currentPropertyId,
  testId,
}: {
  houses: HomeownerHouses;
  contactId: string | null;
  who: string;
  currentPropertyId?: string;
  testId: string;
}) {
  const [more, setMore] = useState<{ houses: HomeownerHouse[]; count: number; done: boolean }>({
    houses: [],
    count: houses.count,
    done: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const focusAfterLoad = useRef<string | null>(null);
  const links = useRef(new Map<string, HTMLAnchorElement>());

  const seen = new Set<string>();
  const listed = [...houses.houses, ...more.houses].filter((house) =>
    seen.has(house.propertyId) ? false : (seen.add(house.propertyId), true),
  );
  const total = Math.max(more.count, listed.length);
  const canLoadMore = Boolean(contactId) && !more.done && listed.length < total;

  // After "Show more", move focus to the first newly listed house.
  useEffect(() => {
    if (!focusAfterLoad.current) return;
    links.current.get(focusAfterLoad.current)?.focus();
    focusAfterLoad.current = null;
  }, [more]);

  async function loadMore() {
    if (!contactId || pending) return;
    setPending(true);
    setError(null);
    const result = await loadMoreHomeownerHousesAction({ contactId, offset: listed.length }).catch(() => null);
    setPending(false);
    if (!result || !result.ok) {
      setError(result?.message ?? "More houses could not load. Try again.");
      return;
    }
    const fresh = result.houses.filter((house) => !seen.has(house.propertyId));
    focusAfterLoad.current = fresh[0]?.propertyId ?? null;
    setMore((prev) => ({
      houses: [...prev.houses, ...fresh],
      count: result.count,
      done: result.nextOffset === null,
    }));
  }

  return (
    <>
      {listed.length === 0 && !canLoadMore ? (
        <p className="px-2 text-[12.5px] text-muted-foreground">List unavailable.</p>
      ) : (
        <ul className="max-h-72 space-y-1 overflow-y-auto" aria-label={`${who}'s houses`}>
          {listed.map((house) => {
            const current = house.propertyId === currentPropertyId;
            const note = current ? "This lead" : house.isMine ? null : house.assignedUserId ? "another rep's lead" : "unassigned";
            return (
              <li key={house.propertyId}>
                <Link
                  ref={(node) => {
                    if (node) links.current.set(house.propertyId, node);
                    else links.current.delete(house.propertyId);
                  }}
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
      )}
      {listed.length < total && (
        <div className="flex flex-wrap items-center justify-between gap-2 px-2">
          <p className="text-[11.5px] text-muted-foreground" aria-live="polite">
            Showing {listed.length} of {total}.
          </p>
          {canLoadMore && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pending}
              onClick={loadMore}
              data-testid={`${testId}-more`}
            >
              {pending ? "Loading…" : listed.length === 0 ? "Load the list" : "Show more"}
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="px-2 text-[11.5px] font-semibold text-destructive">
          {error}
        </p>
      )}
    </>
  );
}
