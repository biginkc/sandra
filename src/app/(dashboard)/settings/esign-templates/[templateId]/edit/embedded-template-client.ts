import type { EmbeddedTemplateSession } from "../../types";

export type EmbeddedTemplateEventMap = Readonly<{
  createTemplate: unknown;
  open: unknown;
  cancel: unknown;
  finish: unknown;
  message: unknown;
  close: unknown;
  error: Readonly<{ code?: string; signatureId?: string }>;
}>;

export type EmbeddedTemplateEvent = keyof EmbeddedTemplateEventMap;

export type EmbeddedTemplateClient = Readonly<{
  on<Event extends EmbeddedTemplateEvent>(
    event: Event,
    listener: (payload: EmbeddedTemplateEventMap[Event]) => void,
  ): void;
  off?<Event extends EmbeddedTemplateEvent>(
    event: Event,
    listener: (payload: EmbeddedTemplateEventMap[Event]) => void,
  ): void;
  open(
    url: string,
    options: Readonly<{
      clientId: string;
      container: HTMLElement;
      skipDomainVerification: boolean;
    }>,
  ): void;
  close(): void;
}>;

export type EmbeddedTemplateListeners = Readonly<{
  onFinish(): void;
  onCancel(): void;
  onClose(): void;
  onError(error: EmbeddedTemplateEventMap["error"]): void;
}>;

export function mountEmbeddedTemplateClient(input: {
  client: EmbeddedTemplateClient;
  session: EmbeddedTemplateSession;
  container: HTMLElement;
  listeners: EmbeddedTemplateListeners;
}): () => void {
  let closed = false;
  const subscriptions = [
    ["finish", input.listeners.onFinish],
    ["cancel", input.listeners.onCancel],
    ["close", input.listeners.onClose],
    ["error", input.listeners.onError],
  ] as const;

  // Events must be attached before open, because the provider may emit an
  // immediate load/error event while it creates the iframe.
  for (const [event, listener] of subscriptions) {
    input.client.on(event, listener as never);
  }
  input.client.open(input.session.editUrl, {
    clientId: input.session.clientId,
    container: input.container,
    skipDomainVerification: input.session.skipDomainVerification,
  });

  return () => {
    if (closed) return;
    closed = true;
    for (const [event, listener] of subscriptions) {
      input.client.off?.(event, listener as never);
    }
    input.client.close();
  };
}
