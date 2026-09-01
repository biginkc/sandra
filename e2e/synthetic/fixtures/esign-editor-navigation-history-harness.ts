import { mountEmbeddedTemplateClient } from "@/app/(dashboard)/settings/esign-templates/[templateId]/edit/embedded-template-client";

const container = document.querySelector<HTMLElement>("#editor-container");
if (!container) throw new Error("Missing editor container");

mountEmbeddedTemplateClient({
  client: {
    on: () => undefined,
    off: () => undefined,
    open: (url, options) => {
      const iframe = document.createElement("iframe");
      iframe.title = "Dropbox Sign template editor";
      iframe.src = url;
      options.container.append(iframe);
    },
    close: () => undefined,
  },
  session: {
    providerTemplateId: "provider-template",
    editUrl: "https://provider.test/editor",
    expiresAt: null,
    clientId: "client-id",
  },
  container,
  skipDomainVerification: true,
  listeners: {
    onFinish: () => undefined,
    onCancel: () => undefined,
    onClose: () => undefined,
    onError: () => undefined,
  },
});
