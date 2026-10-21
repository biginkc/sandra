import "server-only";
import { headers } from "next/headers";

export type ServerActionLog = {
  event: "server_action.timing.v1";
  action: string;
  route: string | null;
  durationMs: number;
  outcome: "ok" | "failed" | "threw";
};

const enabled = () => process.env.SERVER_ACTION_LOG !== "0";

/** Path of the page that dispatched the action (server actions POST to it, so the referer names it). */
async function callerRoute(): Promise<string | null> {
  try {
    const referer = (await headers()).get("referer");
    return referer ? new URL(referer).pathname : null;
  } catch {
    return null;
  }
}

/** One structured line per call so Vercel logs can attribute POST volume and server time to an action name. */
export async function timeServerAction<T>(action: string, run: () => Promise<T>, route?: string): Promise<T> {
  if (!enabled()) return run();
  const started = performance.now();
  let outcome: ServerActionLog["outcome"] = "threw";
  try {
    const result = await run();
    outcome = isFailure(result) ? "failed" : "ok";
    return result;
  } finally {
    const line: ServerActionLog = {
      event: "server_action.timing.v1",
      action,
      route: route ?? (await callerRoute()),
      durationMs: Math.round(performance.now() - started),
      outcome,
    };
    console.info(JSON.stringify(line));
  }
}

function isFailure(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}
