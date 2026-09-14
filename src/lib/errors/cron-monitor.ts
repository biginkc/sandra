import * as Sentry from "@sentry/nextjs";

type MonitorConfig = NonNullable<Parameters<typeof Sentry.captureCheckIn>[1]>;

/** Call only after cron authentication; unauthorized requests are not runs. */
export async function runMonitoredCron<T>(
  slug: string,
  config: MonitorConfig,
  run: () => Promise<T>,
  failed: (result: T) => boolean | Promise<boolean>,
): Promise<T> {
  let checkInId: string | undefined;
  if (Sentry.getClient()) {
    try {
      checkInId = Sentry.captureCheckIn(
        { monitorSlug: slug, status: "in_progress" },
        config,
      );
    } catch {
      // Monitoring cannot prevent the business cron from running.
    }
  }

  let result: T;
  let isFailed = false;
  try {
    result = await run();
    isFailed = await failed(result);
  } catch (error) {
    await finish("error");
    throw error;
  }
  await finish(isFailed ? "error" : "ok");
  return result;

  async function finish(status: "ok" | "error") {
    if (!checkInId) return;
    try {
      Sentry.captureCheckIn({ monitorSlug: slug, checkInId, status });
      await Sentry.flush(2_000);
    } catch {
      // Preserve the route's original response and retry semantics.
    }
  }
}

/** Status and a safe boolean are enough; never inspect or export body fields. */
export async function cronResponseFailed(response: Response): Promise<boolean> {
  if (!response.ok) return true;
  if (!response.headers.get("content-type")?.includes("application/json")) return false;
  try {
    const body: unknown = await response.clone().json();
    return typeof body === "object" && body !== null && "ok" in body && body.ok === false;
  } catch {
    return false;
  }
}
