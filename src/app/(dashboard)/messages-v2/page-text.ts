/**
 * Page wording for messages that come from the server. Library code (outside this page) still says "Jev" in a few
 * places; the page never shows that name, so every server-provided string passes through here before it renders.
 */

/** Undo results by code: never the library's own text. */
export function undoErrorText(code: string): string {
  switch (code) {
    case "STATE_CHANGED":
      return "Sandra already moved on. Refresh and try again.";
    case "NOT_FOUND":
      return "Nothing to undo.";
    case "FORBIDDEN":
    case "UNAUTHORIZED":
      return "You can't undo this.";
    default:
      return "Could not undo. Try again.";
  }
}

/** Any other server string shown on the page: the internal agent name is replaced with Sandra. */
export function pageText(message: string): string;
export function pageText(message: string | null | undefined): string | null;
export function pageText(message: string | null | undefined): string | null {
  if (message == null) return null;
  return message.replace(/\bJev's\b/g, "Sandra's").replace(/\bJev\b/g, "Sandra");
}
