import "server-only";
import { reportError } from "@/lib/errors/report";

/** Never forward Inbox RPC errors: their messages can contain customer data. */
export function reportInboxFailure(operation: string, kind: string): void {
  const error = new Error(`Inbox ${kind}`);
  error.name = "InboxOperationalFailure";
  reportError(error, {
    errorClass: "database",
    tags: { surface: "server", operation, kind },
  });
}
