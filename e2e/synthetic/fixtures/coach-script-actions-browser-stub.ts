import { closrOutbound123Bundle, closrOutbound123Ref } from "@biginkc/coach/fixtures";

let lookupCount = 0;

declare global {
  interface Window {
    coachScriptStartupMode?: "immediate" | "late_index_write";
  }
}

// Synthetic browser harnesses exercise the client-side bound-script path.
// The real action is authenticated and database-backed, so it cannot cross
// the browser bundle boundary in these database-free tests.
export async function loadCoachCallScript() {
  lookupCount += 1;
  if (window.coachScriptStartupMode === "late_index_write" && lookupCount < 3) return { status: "pending" as const };
  return { status: "bound" as const, binding: { ref: closrOutbound123Ref, bundle: closrOutbound123Bundle } };
}
