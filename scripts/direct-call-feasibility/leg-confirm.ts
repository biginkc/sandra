/* eslint-disable @typescript-eslint/no-explicit-any */
// The ONLY ways a leg counts as ended (provider contract, see ACCEPTANCE P1-P4):
//   1. its call.hangup webhook was received,
//   2. a hangup request returned 422 with error code 90018 ("Call has already ended"),
//   3. GET /calls/{id} reported is_alive:false.
// A 2xx hangup, a 404, any other 422, a GET error, or age alone never confirm.
import type { EventLog } from "./event-log";
import type { TelnyxClient } from "./telnyx-client";

/** True only for HTTP 422 carrying provider error code 90018. */
export function isAlreadyEnded(e: unknown): boolean {
  const err = e as any;
  if (err?.status !== 422) return false;
  const errors: any[] = Array.isArray(err?.body?.errors) ? err.body.errors : [];
  return errors.some((x) => String(x?.code) === "90018");
}

/** Webhook, a recorded 90018, or a GET showing is_alive:false. Any GET failure is "not confirmed". */
export async function confirmLegEnded(
  client: Pick<TelnyxClient, "request">,
  log: Pick<EventLog, "hasHangup"> | undefined,
  id: string,
  endedByHangup?: Set<string>,
): Promise<boolean> {
  if (endedByHangup?.has(id)) return true;
  if (log?.hasHangup(id)) return true;
  try {
    const st = (await client.request("GET", `/calls/${id}`)).data;
    return st?.is_alive === false;
  } catch {
    return false;
  }
}
