import type { ReactNode } from "react";

/** Public visual fixture, matching the existing /brand preview mechanism. */
export default function InboxBrandLayout({ children }: { children: ReactNode }) { return <main><style>{"nextjs-portal { display: none !important; }"}</style>{children}</main>; }
