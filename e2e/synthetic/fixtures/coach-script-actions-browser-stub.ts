import { closrOutbound123Bundle, closrOutbound123Ref } from "@biginkc/coach/fixtures";

// Synthetic browser harnesses exercise the client-side bound-script path.
// The real action is authenticated and database-backed, so it cannot cross
// the browser bundle boundary in these database-free tests.
export async function loadCoachCallScript() {
  return { ref: closrOutbound123Ref, bundle: closrOutbound123Bundle };
}
