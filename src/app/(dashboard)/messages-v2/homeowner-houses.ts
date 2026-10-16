"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import type { HomeownerHouses } from "@/lib/leads/homeowner-houses";
import { MAX_HOMEOWNER_IDS } from "@/lib/leads/homeowner-houses";
import { loadHomeownerHousesAction } from "@/lib/leads/homeowner-houses-action";

export type HousesByContact = ReadonlyMap<string, HomeownerHouses>;

/**
 * "Owns N houses" for one list page (the tape, or the waiting pile): ONE batched read for every
 * homeowner on the page (chunked at the action's 100-id limit), never one per card. Ids already
 * read are not asked again when a later page ("Show older", an earlier day) adds more. A failed
 * read simply shows no badge.
 */
export function useHomeownerHouses(contactIds: ReadonlyArray<string | null | undefined>): HousesByContact {
  const [houses, setHouses] = useState<Map<string, HomeownerHouses>>(() => new Map());
  // Ids already asked for (in flight or answered); a ref so asking never re-runs the effect.
  const asked = useRef<Set<string>>(new Set());
  const key = useMemo(
    () => [...new Set(contactIds.filter((id): id is string => !!id))].sort().join(","),
    [contactIds],
  );

  useEffect(() => {
    const missing = key ? key.split(",").filter((id) => !asked.current.has(id)) : [];
    if (missing.length === 0) return;
    for (const id of missing) asked.current.add(id);
    const chunks: string[][] = [];
    for (let i = 0; i < missing.length; i += MAX_HOMEOWNER_IDS) chunks.push(missing.slice(i, i + MAX_HOMEOWNER_IDS));
    // Not cancelled on a later page: these ids are never asked again, so the answer must land.
    void Promise.all(chunks.map((ids) => loadHomeownerHousesAction(ids).catch(() => ({})))).then((results) => {
      setHouses((prev) => {
        const next = new Map(prev);
        for (const r of results) for (const [id, h] of Object.entries(r)) next.set(id, h);
        return next;
      });
    });
  }, [key]);

  return houses;
}
