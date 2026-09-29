import type { ReactNode } from "react";

/** Brand previews are public, deterministic, and do not load dashboard data. */
export default function DripsBrandLayout({ children }: { children: ReactNode }) {
  return <main className="min-h-screen bg-background">{children}</main>;
}
