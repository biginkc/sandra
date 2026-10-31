

import { handleInboundWebhook } from "@/lib/messaging/inbound";
import { MockMessagingProvider } from "@/lib/messaging/providers/mock";

/**
 * Real inbound path: handleInboundWebhook (mock provider payload, real signature check, real
 * webhook-event reservation, intent claim, keyword prechecks, insert, stamp) -> the delay workflow.
 * The workflow runtime is not available in vitest, so each test file mocks `workflow/api`.start to
 * hand the params to `workflowSink`, and `workflow`.sleep to resolve at once; the sink runs the
 * REAL aiReplyDelayWorkflow body (dispatchStep -> dispatchAiResponse -> stamp) in-process.
 */
export { workflowSink, type WorkflowCall } from "./wf-mock";

export const webhookErrors: Array<{ status: number; body: string; ext: string }> = [];
export async function deliverWebhook(ev: { externalId: string; from: string; to: string; body: string }): Promise<number> {
  const res = await handleInboundWebhook(
    new Request("https://stress.test/webhooks/mock", {
      method: "POST",
      headers: { "content-type": "application/json", "x-mock-signature": "valid" },
      body: JSON.stringify(ev),
    }),
    { includeFullUrl: false, provider: new MockMessagingProvider() },
  );
  if (res.status !== 200) webhookErrors.push({ status: res.status, body: (await res.text().catch(() => "")).slice(0, 300), ext: ev.externalId });
  return res.status;
}

/** Bounded async pool. */
export class Pool {
  private active = 0;
  private q: Array<() => void> = [];
  maxSeen = 0;
  constructor(private size: number) {}
  async run<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= this.size) await new Promise<void>((r) => this.q.push(r));
    this.active++;
    this.maxSeen = Math.max(this.maxSeen, this.active);
    try { return await f(); } finally { this.active--; this.q.shift()?.(); }
  }
}
