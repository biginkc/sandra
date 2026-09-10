"use client";
import { useEffect } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { finishNavigationTiming } from "./browser-timing";

/** Mounted with usable page content, never inside a skeleton/loading boundary. */
export function NavigationReady() {
  const path = usePathname();
  const search = useSearchParams().toString();
  useEffect(() => { finishNavigationTiming(); }, [path, search]);
  return null;
}
