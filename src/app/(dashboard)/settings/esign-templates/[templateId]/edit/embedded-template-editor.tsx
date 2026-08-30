"use client";

import { LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { requireTemplateTitle } from "@/lib/esign/template-contract";

import type { TemplateEditorActions, TemplateEditorData } from "../../types";
import {
  loadOfficialEmbeddedTemplateClient,
  mountEmbeddedTemplateClient,
  shouldSkipDomainVerification,
  type EmbeddedTemplateClient,
} from "./embedded-template-client";
import { MergeFieldLegend } from "./merge-field-legend";
import { TemplateFileStrip } from "./template-file-strip";

type EditorState =
  | { status: "unavailable" }
  | { status: "loading" }
  | { status: "open" }
  | { status: "syncing" }
  | { status: "finished" }
  | { status: "error"; message: string; code?: string };

export function EmbeddedTemplateEditor({
  template,
  actions,
  loadClient,
}: {
  template: TemplateEditorData;
  actions?: TemplateEditorActions;
  loadClient?: (clientId: string) => Promise<EmbeddedTemplateClient>;
}) {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const terminalReason = useRef<"finish" | "cancel" | null>(null);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<EditorState>(
    actions ? { status: "loading" } : { status: "unavailable" },
  );
  const [pending, startTransition] = useTransition();

  const syncFinished = useCallback(async () => {
    if (!actions) return;
    setState({ status: "syncing" });
    let name: string;
    try {
      name = requireTemplateTitle(template.name);
    } catch (error) {
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "The template name is invalid.",
        code: "INVALID_TEMPLATE_TITLE",
      });
      return;
    }
    const result = await actions.syncFinishedTemplate({ name });
    if (!result.ok) {
      setState({ status: "error", message: result.error.message, code: result.error.code });
      return;
    }
    setState({ status: "finished" });
  }, [actions, template.name]);

  const abandonAndReturn = useCallback(async () => {
    if (!actions || template.isFinalized) {
      router.push("/settings/esign-templates");
      return;
    }
    const result = await actions.abandonDraft();
    if (!result.ok) {
      setState({ status: "error", message: result.error.message, code: result.error.code });
      return;
    }
    router.push("/settings/esign-templates");
  }, [actions, router, template.isFinalized]);

  useEffect(() => {
    if (!actions || !containerRef.current) return;
    let disposed = false;
    setState({ status: "loading" });
    terminalReason.current = null;
    void actions.startEditor().then(async (session) => {
      if (!session.ok) {
        if (!disposed) {
          setState({ status: "error", message: session.error.message, code: session.error.code });
        }
        return;
      }
      const client = await (loadClient ?? loadOfficialEmbeddedTemplateClient)(session.data.clientId);
      if (disposed) {
        client.close();
        return;
      }
      if (!containerRef.current) {
        client.close();
        setState({
          status: "error",
          message: "The editor container is unavailable.",
          code: "EDITOR_CONTAINER_MISSING",
        });
        return;
      }
      cleanupRef.current = mountEmbeddedTemplateClient({
        client,
        session: session.data,
        container: containerRef.current,
        skipDomainVerification: shouldSkipDomainVerification({
          hostname: window.location.hostname,
          deploymentEnvironment: process.env.NEXT_PUBLIC_VERCEL_ENV,
        }),
        listeners: {
          onFinish: () => {
            terminalReason.current = "finish";
            void syncFinished();
          },
          onCancel: () => {
            terminalReason.current = "cancel";
          },
          onClose: () => {
            if (terminalReason.current === "cancel") void abandonAndReturn();
          },
          onError: (error) => setState({ status: "error", message: "Dropbox Sign could not load the template editor.", code: error.code }),
        },
      });
      setState({ status: "open" });
    }).catch((error: unknown) => {
      if (disposed) return;
      setState({
        status: "error",
        message: error instanceof Error ? error.message : "Dropbox Sign could not start the editor.",
        code: "EDITOR_START_FAILED",
      });
    });
    return () => {
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [abandonAndReturn, actions, generation, loadClient, router, syncFinished]);

  const cancel = () => {
    cleanupRef.current?.();
    cleanupRef.current = null;
    startTransition(abandonAndReturn);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumb={[
          { label: "Settings", href: "/settings/integrations" },
          { label: "eSign templates", href: "/settings/esign-templates" },
          { label: "Edit" },
        ]}
        title={template.name}
        description="Finish field placement inside Dropbox Sign, then synchronize the template back to Sandra."
        actions={
          <>
            <Button variant="outline" onClick={cancel} disabled={pending}>Cancel</Button>
            <Button onClick={() => router.push("/settings/esign-templates")} disabled={state.status !== "finished"} title={state.status === "finished" ? undefined : "Finish in the Dropbox Sign editor first."}>
              Save template
            </Button>
          </>
        }
      />
      <TemplateFileStrip template={template} />
      <MergeFieldLegend />

      <section className="relative min-h-[520px] w-full overflow-hidden rounded-xl border bg-card" aria-label="Dropbox Sign template editor">
        <div ref={containerRef} className="min-h-[520px] w-full" data-testid="embedded-template-container" />
        {(state.status === "loading" || state.status === "syncing") && (
          <div className="bg-background/90 absolute inset-0 flex min-h-[520px] items-center justify-center">
            <p className="flex items-center gap-2 text-sm"><LoaderCircleIcon className="animate-spin" />{state.status === "syncing" ? "Synchronizing finished template…" : "Loading Dropbox Sign editor…"}</p>
          </div>
        )}
        {state.status === "unavailable" && (
          <EditorNotice title="Editor connection pending" message="The reviewed Dropbox Sign foundation must be connected before this editor can open." />
        )}
        {state.status === "error" && (
          <div className="bg-background/95 absolute inset-0 flex min-h-[520px] flex-col items-center justify-center gap-3 p-6 text-center" role="alert">
            <div><h2 className="font-medium">Editor unavailable</h2><p className="text-muted-foreground mt-1 max-w-lg text-sm">{state.message}</p>{state.code && <p className="text-muted-foreground mt-2 font-mono text-xs">{state.code}</p>}</div>
            <Button variant="outline" size="sm" onClick={() => setGeneration((value) => value + 1)}><RefreshCwIcon data-icon="inline-start" /> Reload editor</Button>
          </div>
        )}
      </section>
      {state.status !== "finished" && <p className="text-muted-foreground text-sm">Finish in the Dropbox Sign editor first. Sandra cannot force-save or roll back cross-origin editor state.</p>}
    </div>
  );
}

function EditorNotice({ title, message }: { title: string; message: string }) {
  return <div className="bg-background/95 absolute inset-0 flex min-h-[520px] items-center justify-center p-6 text-center"><div><h2 className="font-medium">{title}</h2><p className="text-muted-foreground mt-1 max-w-lg text-sm">{message}</p></div></div>;
}
