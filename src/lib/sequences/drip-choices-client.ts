import type { Result } from "@/lib/errors/result";
import { timeClientCall } from "@/lib/perf/client-action-timing";
import type { DripChoice } from "@/lib/sequences/drip-choices";

// A GET keeps this small read out of the one-at-a-time server-action queue that My Leads list refreshes occupy.
const PATH = "/api/sequences/drip-choices";

export const fetchDripChoices = timeClientCall("GET drip-choices", async (): Promise<Result<DripChoice[]>> => {
  const response = await fetch(PATH, { cache: "no-store", credentials: "same-origin" });
  return (await response.json()) as Result<DripChoice[]>;
}, () => PATH);
