declare module "hellosign-embedded" {
  type Listener = (payload: unknown) => void;

  export default class HelloSign {
    constructor(options: { clientId: string });
    on(event: string, listener: Listener): void;
    off(event: string, listener: Listener): void;
    open(
      url: string,
      options?: {
        container?: HTMLElement;
        skipDomainVerification?: boolean;
      },
    ): void;
    close(): void;
  }
}
