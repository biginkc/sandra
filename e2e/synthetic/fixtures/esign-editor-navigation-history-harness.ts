import type { EmbeddedTemplateSession } from "@/app/(dashboard)/settings/esign-templates/types";
import { mountEmbeddedTemplateClient } from "@/app/(dashboard)/settings/esign-templates/[templateId]/edit/embedded-template-client";

const app = requireAppContainer();

const initialSessions = new Map<string, EmbeddedTemplateSession>();
initialSessions.set("template-1", makeSession("template-1", "initial"));

let cleanupEditor: (() => void) | null = null;
let renderTimer = 0;

document.addEventListener("click", (event) => {
  const link = (event.target as Element | null)?.closest<HTMLAnchorElement>(
    "a[data-spa-link]",
  );
  if (!link || link.origin !== location.origin) return;
  event.preventDefault();
  navigate(link.pathname);
});

// Let the editor boundary finish an exact-entry Back traversal before the
// synthetic app applies the route remount caused by that traversal.
window.addEventListener("popstate", () => {
  window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(renderRoute, 20);
});

renderRoute();

function renderRoute() {
  cleanupEditor?.();
  cleanupEditor = null;
  app.replaceChildren();

  if (location.pathname === "/settings/esign-templates") {
    app.innerHTML = `
      <h1>Template library</h1>
      <a data-spa-link href="/settings/esign-templates/template-1/edit">Create unfinished draft</a>
      <a data-spa-link href="/settings/esign-templates/finalized-1/edit">Edit finalized template</a>
    `;
    return;
  }

  if (location.pathname === "/another-route") {
    app.innerHTML = "<h1>Another route</h1>";
    return;
  }

  const match = location.pathname.match(
    /^\/settings\/esign-templates\/([^/]+)\/edit$/,
  );
  if (!match) {
    app.innerHTML = "<h1>Not found</h1>";
    return;
  }

  const templateId = match[1];
  app.innerHTML = `
    <h1>Template editor</h1>
    <a data-spa-link href="/settings/esign-templates">Template library</a>
    <a data-spa-link href="/another-route">Another route</a>
    ${templateId === "template-1" ? '<button id="restart-placement">Restart placement</button>' : ""}
    <div id="editor-container"></div>
  `;

  document.querySelector("#restart-placement")?.addEventListener("click", () => {
    const replacementId = "replacement-1";
    initialSessions.set(
      replacementId,
      makeSession(replacementId, "replacement"),
    );
    // Models Next router.replace: the old guard's custom state is replaced.
    history.replaceState({}, "", `/settings/esign-templates/${replacementId}/edit`);
    renderRoute();
  });

  const session = takeInitialSession(templateId) ?? startEditor(templateId);
  if (!session) {
    const error = document.createElement("p");
    error.setAttribute("role", "alert");
    error.textContent = "startEditor failed: 404/not_found";
    app.append(error);
    return;
  }

  const container = document.querySelector<HTMLElement>("#editor-container");
  if (!container) throw new Error("Missing editor container");
  cleanupEditor = mountEmbeddedTemplateClient({
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
    session,
    container,
    skipDomainVerification: true,
    listeners: {
      onFinish: () => undefined,
      onCancel: () => undefined,
      onClose: () => undefined,
      onError: () => undefined,
    },
    onBeforeHistoryReturn: () => initialSessions.set(templateId, session),
  });
}

function navigate(pathname: string) {
  history.pushState({}, "", pathname);
  renderRoute();
}

function takeInitialSession(
  templateId: string,
): EmbeddedTemplateSession | null {
  const session = initialSessions.get(templateId) ?? null;
  initialSessions.delete(templateId);
  return session;
}

function startEditor(templateId: string): EmbeddedTemplateSession | null {
  const harnessWindow = window as Window & {
    __startEditorAttempts?: Record<string, number>;
  };
  harnessWindow.__startEditorAttempts ??= {};
  harnessWindow.__startEditorAttempts[templateId] =
    (harnessWindow.__startEditorAttempts[templateId] ?? 0) + 1;
  // An unfinished initial draft cannot obtain a later edit URL. Finalized
  // templates model the ordinary startEditor path used on a route remount.
  return templateId === "finalized-1"
    ? makeSession(templateId, `fresh-${Date.now()}`)
    : null;
}

function makeSession(
  templateId: string,
  revision: string,
): EmbeddedTemplateSession {
  return {
    providerTemplateId: `provider-${templateId}`,
    editUrl: `https://provider.test/editor/${templateId}/${revision}`,
    expiresAt: null,
    clientId: "client-id",
  };
}

function requireAppContainer(): HTMLElement {
  const container = document.querySelector<HTMLElement>("#app");
  if (!container) throw new Error("Missing app container");
  return container;
}
