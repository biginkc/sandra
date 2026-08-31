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

type HelloSignClientConstructor = new (options: Readonly<{ clientId: string }>) =>
  EmbeddedTemplateClient;

export type EmbeddedClientEnvironment = Readonly<{
  hostname: string;
  deploymentEnvironment?: string;
}>;

export function shouldSkipDomainVerification(
  environment: EmbeddedClientEnvironment,
): boolean {
  const hostname = environment.hostname.toLowerCase();
  const isLocalhost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname.endsWith(".localhost");
  return isLocalhost || environment.deploymentEnvironment === "preview";
}

export async function loadOfficialEmbeddedTemplateClient(
  clientId: string,
): Promise<EmbeddedTemplateClient> {
  // Keep the browser-only SDK out of the server bundle and load it only when
  // the client component has a fresh provider edit session to open.
  const embeddedSdk = await import("hellosign-embedded");
  const HelloSign = embeddedSdk.default as HelloSignClientConstructor;
  return new HelloSign({ clientId });
}

export function mountEmbeddedTemplateClient(input: {
  client: EmbeddedTemplateClient;
  session: EmbeddedTemplateSession;
  container: HTMLElement;
  skipDomainVerification: boolean;
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
    container: input.container,
    skipDomainVerification: input.skipDomainVerification,
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
