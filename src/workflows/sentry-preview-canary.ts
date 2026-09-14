import { reportTerminalWorkflowFailure } from "./terminal-telemetry";

async function failCanaryStep(): Promise<void> {
  "use step";
  throw new Error("Controlled Sentry canary Workflow failure");
}
Object.assign(failCanaryStep, { maxRetries: 0 });

export async function sentryPreviewCanaryWorkflow(): Promise<void> {
  "use workflow";
  try {
    await failCanaryStep();
  } catch (error) {
    try {
      await reportTerminalWorkflowFailure("sentry_preview_canary");
    } catch {
      // The canary verifies delivery; the original Workflow failure remains.
    }
    throw error;
  }
}
