import { randomUUID } from "node:crypto";

/** No app imports here: loaded from vi.mock factories. */
export type WorkflowCall = { fn: (p: unknown) => Promise<unknown>; params: { inboundMessageId: string; propertyId: string } & Record<string, unknown> };
export const workflowSink: { onStart: ((c: WorkflowCall) => void) | null } = { onStart: null };

export const workflowMocks = {
  api: async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    start: async (fn: WorkflowCall["fn"], args: [WorkflowCall["params"]]) => {
      workflowSink.onStart?.({ fn, params: args[0] });
      return { runId: `stress-${randomUUID()}` };
    },
  }),
  core: async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    sleep: async () => undefined,
  }),
};

