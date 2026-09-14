import * as Sentry from "@sentry/nextjs";

/** Run only from a Node step after the business step has exhausted retries. */
export async function reportTerminalWorkflowFailure(
  operation: "skip_trace_submit" | "sentry_preview_canary",
): Promise<void> {
  "use step";

  if (!Sentry.getClient()) return;
  try {
    Sentry.withScope((scope) => {
      scope.setTag("surface", "workflow");
      scope.setTag("operation", operation);
      scope.setTag("kind", "terminal_failure");
      // The workflow's original error can contain customer/provider data.
      // Its persisted job state retains the detail needed for local repair.
      Sentry.captureException(new Error(`Workflow terminal failure: ${operation}`));
    });
    await Sentry.flush(2_000);
  } catch {
    // Telemetry must not replace the durable workflow's original outcome.
  }
}

Object.assign(reportTerminalWorkflowFailure, { maxRetries: 0 });
