import Link from "next/link";

import { getCallerMemberships } from "@/lib/auth/memberships";
import {
  leadDetailCollection,
  shouldRestrictMessagesAndLeadsBoard,
} from "@/lib/auth/surface-access";

/**
 * Renders when a lead id doesn't resolve to a row (page.tsx calls
 * notFound()). Plain server component, no hooks — visiting a missing
 * lead id previously fell through to the framework's default error
 * boundary and threw client React #310 (a hook mismatch from a client
 * component trying to render around the thrown NEXT_NOT_FOUND signal).
 */
export default async function LeadNotFound() {
  const collection = leadDetailCollection(
    shouldRestrictMessagesAndLeadsBoard(await getCallerMemberships()),
  );
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-24 text-center">
      <h1 className="text-lg font-semibold">This lead no longer exists</h1>
      <p className="text-muted-foreground text-sm">
        It may have been deleted or the link may be out of date.
      </p>
      <Link href={collection.href} className="text-primary text-sm underline underline-offset-4">
        Back to {collection.label}
      </Link>
    </div>
  );
}
