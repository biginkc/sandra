"use client";

import { RefreshCwIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";

import { templateLibraryActions } from "./client-actions";
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
        <h2 id="pending-template-copies-title" className="font-medium">Copies still preparing</h2>
        <p className="text-muted-foreground text-sm">These hidden copies are not available for sending until setup finishes.</p>
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
  copy: { id: string; name: string; lifecycle: "preparing" | "editing" | "cleanup_attention" };
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
      setError("Copy is still preparing");
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
    const result = await actions.retryCleanup(copy.id);
    if (!result.ok) return setError(result.error.message);
    router.refresh();
  });

  const cleanupAttention = copy.lifecycle === "cleanup_attention";

  return (
    <div className="bg-muted/30 flex flex-col gap-3 rounded-lg border px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="font-medium">{copy.name}</p>
        <p className="text-muted-foreground text-sm">{cleanupAttention ? "Cleanup needs attention" : "Copy is still preparing"}</p>
        {error && <p role="alert" className={error === "Copy is still preparing" ? "text-muted-foreground mt-1 text-sm" : "text-destructive mt-1 text-sm"}>{error}</p>}
      </div>
      <div className="flex gap-2">
        {cleanupAttention ? (
          <Button size="sm" variant="outline" onClick={retryCleanup} disabled={!actions || isPending}>
            <RefreshCwIcon data-icon="inline-start" /> {isPending ? "Retrying…" : "Retry cleanup"}
          </Button>
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
