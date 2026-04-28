"use client";

import { useEffect, useState } from "react";

/**
 * Shows a thin banner at the top of the page when the browser is offline.
 * Uses the `navigator.onLine` API + `online`/`offline` window events.
 * Server-rendered components aren't affected; this only flashes into
 * existence client-side when connectivity drops.
 */
export function ConnectionBanner() {
  const [online, setOnline] = useState<boolean>(true);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  if (online) return null;

  return (
    <div className="bg-destructive text-destructive-foreground fixed inset-x-0 top-0 z-50 flex items-center justify-center gap-2 px-4 py-1.5 text-sm">
      <span className="size-2 animate-pulse rounded-full bg-current" />
      <span>You are offline. Changes will not save until your connection returns.</span>
    </div>
  );
}
