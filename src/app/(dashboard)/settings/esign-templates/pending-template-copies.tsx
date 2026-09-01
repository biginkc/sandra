"use client";

import { RefreshCwIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { templateLibraryActions } from "./client-actions";
import { useInitialEditorSessionStore } from "./initial-editor-session";
import type { PendingTemplateCopiesLoadResult, TemplateLibraryActions } from "./types";

export function PendingTemplateCopies({
  result,
  actions = templateLibraryActions,
}: {
  result: PendingTemplateCopiesLoadResult;
  actions?: TemplateLibraryActions;
}) {
  if (!result.ok) {
    return (
      <div className="border-destructive/40 bg-destructive/5 rounded-xl border p-4" role="alert">
        <p className="font-medium">Pending copies could not be loaded</p>
        <p className="text-muted-foreground mt-1 text-sm">{result.error.message} Reload this page before creating another copy.</p>
      </div>
    );
  }
  if (result.data.length === 0) return null;
  return (
    <section className="border-border rounded-xl border p-4" aria-labelledby="pending-template-copies-title">
      <div className="mb-3">
        <h2 id="pending-template-copies-title" className="font-medium">Templates still preparing</h2>
        <p className="text-muted-foreground text-sm">These hidden copies and edit revisions are not available for sending until setup finishes.</p>
      </div>
      <div className="space-y-2">
        {result.data.map((copy) => <PendingTemplateCopyRow key={copy.id} copy={copy} actions={actions} />)}
      </div>
    </section>
  );
}

function PendingTemplateCopyRow({
  copy,
  actions,
}: {
  copy: { id: string; name: string; lifecycle: "preparing" | "editing" | "cleanup_attention" | "provider_attention"; kind?: "copy" | "edit_revision" | "placement_restart" | "source_cleanup" | "provider_create"; providerCreateState?: "unstarted" | "claimed" | "invoking" | "unknown" | "attached" };
  actions?: TemplateLibraryActions;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const [routed, setRouted] = useState(false);
  const mountedRef = useRef(true);
  const readinessPromiseRef = useRef<Promise<void> | null>(null);
  const routedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reload = () => {
    if (!actions || routedRef.current || readinessPromiseRef.current) return readinessPromiseRef.current;
    setError(null);
    setCheckingReadiness(true);
    const request = actions.checkEditorReadiness(copy.id).then((result) => {
      if (!mountedRef.current || routedRef.current) return;
      if (!result.ok) return setError(result.error.message);
      if (result.data.readiness === "ready") {
        routedRef.current = true;
        setRouted(true);
        router.push(`/settings/esign-templates/${copy.id}/edit`);
        return;
      }
      setError(copy.kind === "edit_revision" ? "Edit revision is still preparing" : "Copy is still preparing");
    }).finally(() => {
      if (readinessPromiseRef.current === request) readinessPromiseRef.current = null;
      if (mountedRef.current && !routedRef.current) setCheckingReadiness(false);
    });
    readinessPromiseRef.current = request;
    return request;
  };

  const cancel = () => actions && !routedRef.current && !readinessPromiseRef.current && startTransition(async () => {
    setError(null);
    const result = await actions.abandonDraft(copy.id);
    if (!result.ok) return setError(result.error.message);
    router.refresh();
  });

  const retryCleanup = () => actions && !routedRef.current && !readinessPromiseRef.current && startTransition(async () => {
    setError(null);
    const result = copy.kind === "source_cleanup" && actions.retrySourceCleanup
      ? await actions.retrySourceCleanup(copy.id)
      : await actions.retryCleanup(copy.id);
    if (!result.ok) return setError(result.error.message);
    router.refresh();
  });

  const checkStaleProviderCreate = () =>
    actions?.promoteStaleProviderCreate &&
    !routedRef.current &&
    !readinessPromiseRef.current &&
    startTransition(async () => {
      setError(null);
      const result = await actions.promoteStaleProviderCreate!(copy.id);
      if (!result.ok) return setError(result.error.message);
      router.refresh();
    });

  const cleanupAttention = copy.lifecycle === "cleanup_attention";
  const providerAttention = copy.lifecycle === "provider_attention";
  const preparingMessage = copy.kind === "edit_revision" ? "Edit revision is still preparing" : "Copy is still preparing";

  return (
    <div className="bg-muted/30 flex flex-col gap-3 rounded-lg border px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium">{copy.name}</p>
        <p className="text-muted-foreground text-sm">{cleanupAttention ? "Cleanup needs attention" : providerAttention ? "Provider setup needs attention" : preparingMessage}</p>
        {providerAttention && copy.providerCreateState && (
          <p className="text-muted-foreground mt-1 text-sm">
            {copy.providerCreateState === "claimed" && "Provider creation is safely claimed. Reload this page later; Sandra will not start a second provider template."}
            {copy.providerCreateState === "unstarted" && "Dropbox Sign rejected the previous request without creating a template. Correct the provider issue, then retry setup."}
            {copy.providerCreateState === "invoking" && "Dropbox Sign may have created this template. Do not retry creation. Contact an administrator for provider recovery."}
            {copy.providerCreateState === "unknown" && "Dropbox Sign creation is uncertain. Contact an administrator for provider recovery."}
            {copy.providerCreateState === "attached" && "Provider setup is attached. Continue to finish setup."}
          </p>
        )}
        {error && <p role="alert" className={error === preparingMessage ? "text-muted-foreground mt-1 text-sm" : "text-destructive mt-1 text-sm"}>{error}</p>}
      </div>
      <div className="flex gap-2">
        {cleanupAttention ? (
          <Button size="sm" variant="outline" onClick={retryCleanup} disabled={!actions || isPending}>
            <RefreshCwIcon data-icon="inline-start" /> {isPending ? "Retrying…" : "Retry cleanup"}
          </Button>
        ) : providerAttention ? (
          copy.providerCreateState === "unstarted" ? (
            <RetryProviderCreateButton
              templateId={copy.id}
              retryProviderCreate={actions?.retryProviderCreate}
              onError={setError}
              onRoute={() => {
                routedRef.current = true;
                setRouted(true);
              }}
              disabled={isPending || routed}
            />
          ) : copy.providerCreateState === "invoking" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={checkStaleProviderCreate}
              disabled={!actions?.promoteStaleProviderCreate || isPending || routed}
            >
              <RefreshCwIcon data-icon="inline-start" /> {isPending ? "Checking…" : "Check recovery"}
            </Button>
          ) : copy.providerCreateState === "claimed" ? (
            <Button size="sm" variant="outline" onClick={() => router.refresh()} disabled={isPending || routed}>
              <RefreshCwIcon data-icon="inline-start" /> Reload
            </Button>
          ) : copy.providerCreateState === "attached" ? (
            <>
              <Button size="sm" variant="outline" onClick={() => {
                if (routedRef.current) return;
                routedRef.current = true;
                setRouted(true);
                router.push(`/settings/esign-templates/${copy.id}/edit`);
              }} disabled={routed}>
                Continue setup
              </Button>
              <Button size="sm" variant="ghost" onClick={cancel} disabled={!actions || isPending || routed}>
                <XIcon data-icon="inline-start" /> Cancel
              </Button>
            </>
          ) : (
            <Button size="sm" variant="outline" onClick={() => router.refresh()} disabled={isPending || routed}>
              <RefreshCwIcon data-icon="inline-start" /> Reload
            </Button>
          )
        ) : <>
          <Button size="sm" variant="outline" onClick={() => void reload()} disabled={!actions || isPending || checkingReadiness || routed}>
            <RefreshCwIcon data-icon="inline-start" /> {checkingReadiness ? "Checking…" : "Reload"}
          </Button>
          <Button size="sm" variant="ghost" onClick={cancel} disabled={!actions || isPending || checkingReadiness || routed}>
            <XIcon data-icon="inline-start" /> Cancel
          </Button>
        </>}
      </div>
    </div>
  );
}

function RetryProviderCreateButton({
  templateId,
  retryProviderCreate,
  onError,
  onRoute,
  disabled,
}: {
  templateId: string;
  retryProviderCreate: TemplateLibraryActions["retryProviderCreate"];
  onError(message: string): void;
  onRoute(): void;
  disabled: boolean;
}) {
  const router = useRouter();
  const sessions = useInitialEditorSessionStore();
  const [isPending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!retryProviderCreate || isPending || disabled}
      onClick={() =>
        retryProviderCreate &&
        startTransition(async () => {
          onError("");
          const result = await retryProviderCreate(templateId);
          if (!result.ok) {
            onError(result.error.message);
            return;
          }
          sessions.put(
            result.data.templateId,
            result.data.initialEditorSession,
          );
          onRoute();
          router.push(
            `/settings/esign-templates/${result.data.templateId}/edit`,
          );
        })
      }
    >
      <RefreshCwIcon data-icon="inline-start" />
      {isPending ? "Retrying…" : "Retry setup"}
    </Button>
  );
}
