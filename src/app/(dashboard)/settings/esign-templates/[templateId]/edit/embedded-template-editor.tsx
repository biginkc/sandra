"use client";

import { LoaderCircleIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";

import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/page-header";
import { requireTemplateTitle } from "@/lib/esign/template-contract";

import {
  abandonTemplateDraftAction,
  restartTemplatePlacementAction,
  startTemplateEditorAction,
  syncFinishedTemplateAction,
} from "../../actions";
import { safeTemplateCallAction } from "../../client-actions";

import type {
  EmbeddedTemplateSession,
  TemplateEditorActions,
  TemplateEditorData,
} from "../../types";
import { useInitialEditorSessionStore } from "../../initial-editor-session";
import {
  loadOfficialEmbeddedTemplateClient,
  mountEmbeddedTemplateClient,
  shouldSkipDomainVerification,
  type EmbeddedTemplateClient,
} from "./embedded-template-client";
import { MergeFieldLegend } from "./merge-field-legend";
import { TemplateFileStrip } from "./template-file-strip";

// Dropbox Sign reports expires_at as an epoch-seconds Unix timestamp.
const INITIAL_SESSION_EXPIRY_MARGIN_SECONDS = 30;

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
  initialSession,
  preserveSessionForHistoryReturn,
}: {
  template: TemplateEditorData;
  actions?: TemplateEditorActions;
  loadClient?: (clientId: string) => Promise<EmbeddedTemplateClient>;
  initialSession?: EmbeddedTemplateSession | null;
  preserveSessionForHistoryReturn?: (session: EmbeddedTemplateSession) => void;
}) {
  const router = useRouter();
  const editorActions = useMemo<TemplateEditorActions>(
    () =>
      actions ?? {
        startEditor: () =>
          safeTemplateCallAction(startTemplateEditorAction(template.id), {
            fallbackMessage: "The editor could not be opened.",
          }),
        restartPlacement: () =>
          safeTemplateCallAction(restartTemplatePlacementAction(template.id), {
            fallbackMessage: "Field placement could not be restarted.",
          }),
        syncFinishedTemplate: (input) =>
          safeTemplateCallAction(
            syncFinishedTemplateAction(template.id, input),
            {
              fallbackMessage:
                "The finished template could not be synchronized.",
            },
          ),
        abandonDraft: () =>
          safeTemplateCallAction(abandonTemplateDraftAction(template.id), {
            fallbackMessage: "The draft could not be abandoned.",
          }),
      },
    [actions, template.id],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const terminalReason = useRef<"finish" | "cancel" | null>(null);
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<EditorState>({ status: "loading" });
  const [pending, startTransition] = useTransition();
  const initialSessionRef = useRef(initialSession ?? null);

  const syncFinished = useCallback(async () => {
    setState({ status: "syncing" });
    let name: string;
    try {
      name = requireTemplateTitle(template.name);
    } catch (error) {
      setState({
        status: "error",
        message:
          error instanceof Error
            ? error.message
            : "The template name is invalid.",
        code: "INVALID_TEMPLATE_TITLE",
      });
      return;
    }
    const result = await editorActions.syncFinishedTemplate({ name });
    if (!result.ok) {
      setState({
        status: "error",
        message: result.error.message,
        code: result.error.code,
      });
      return;
    }
    setState({ status: "finished" });
  }, [editorActions, template.name]);

  const abandonAndReturn = useCallback(async () => {
    if (template.isFinalized) {
      router.push("/settings/esign-templates");
      return;
    }
    const result = await editorActions.abandonDraft();
    if (!result.ok) {
      setState({
        status: "error",
        message: result.error.message,
        code: result.error.code,
      });
      return;
    }
    router.push("/settings/esign-templates");
  }, [editorActions, router, template.isFinalized]);

  useEffect(() => {
    if (!containerRef.current) return;
    let disposed = false;
    setState({ status: "loading" });
    terminalReason.current = null;
    const candidateSession =
      generation === 0 ? initialSessionRef.current : null;
    initialSessionRef.current = null;
    const suppliedSession =
      candidateSession &&
      (candidateSession.expiresAt === null ||
        candidateSession.expiresAt >
          Date.now() / 1000 + INITIAL_SESSION_EXPIRY_MARGIN_SECONDS)
        ? candidateSession
        : null;
    const sessionRequest = suppliedSession
      ? Promise.resolve({ ok: true as const, data: suppliedSession })
      : editorActions.startEditor();
    void sessionRequest
      .then(async (session) => {
        if (!session.ok) {
          if (!disposed) {
            setState({
              status: "error",
              message: session.error.message,
              code: session.error.code,
            });
          }
          return;
        }
        const client = await (loadClient ?? loadOfficialEmbeddedTemplateClient)(
          session.data.clientId,
        );
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
            onError: (error) =>
              setState({
                status: "error",
                message: "Dropbox Sign could not load the template editor.",
                code: error.code,
              }),
          },
          onBeforeHistoryReturn: () =>
            preserveSessionForHistoryReturn?.(session.data),
        });
        setState({ status: "open" });
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setState({
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "Dropbox Sign could not start the editor.",
          code: "EDITOR_START_FAILED",
        });
      });
    return () => {
      disposed = true;
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [
    abandonAndReturn,
    editorActions,
    generation,
    loadClient,
    preserveSessionForHistoryReturn,
    router,
    syncFinished,
  ]);

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
            <Button variant="outline" onClick={cancel} disabled={pending}>
              Cancel
            </Button>
            <Button
              onClick={() => router.push("/settings/esign-templates")}
              disabled={state.status !== "finished"}
              title={
                state.status === "finished"
                  ? undefined
                  : "Finish in the Dropbox Sign editor first."
              }
            >
              Save template
            </Button>
          </>
        }
      />
      <section
        className="w-full overflow-hidden rounded-2xl border bg-card"
        aria-label="Dropbox Sign template editor"
      >
        <TemplateFileStrip template={template} />
        <div className="relative min-h-[520px] w-full border-y">
          <div
            ref={containerRef}
            className="min-h-[520px] w-full"
            data-testid="embedded-template-container"
          />
          {(state.status === "loading" || state.status === "syncing") && (
            <div className="bg-background/90 absolute inset-0 flex min-h-[520px] items-center justify-center">
              <p className="flex items-center gap-2 text-sm">
                <LoaderCircleIcon className="animate-spin" />
                {state.status === "syncing"
                  ? "Synchronizing finished template…"
                  : "Loading Dropbox Sign editor…"}
              </p>
            </div>
          )}
          {state.status === "unavailable" && (
            <EditorNotice
              title="Editor connection pending"
              message="The reviewed Dropbox Sign foundation must be connected before this editor can open."
            />
          )}
          {state.status === "error" && (
            <div
              className="bg-background/95 absolute inset-0 flex min-h-[520px] flex-col items-center justify-center gap-3 p-6 text-center"
              role="alert"
            >
              <div>
                <h2 className="font-medium">
                  {isSynchronizationRetry(state.code)
                    ? "Synchronization pending"
                    : "Editor unavailable"}
                </h2>
                <p className="text-muted-foreground mt-1 max-w-lg text-sm">
                  {state.message}
                </p>
                {state.code && (
                  <p className="text-muted-foreground mt-2 font-mono text-xs">
                    {state.code}
                  </p>
                )}
              </div>
              {state.code === "DRAFT_EDITOR_SESSION_LOST" ? (
                <RestartPlacementButton
                  restartPlacement={editorActions.restartPlacement}
                  onError={(error) =>
                    setState({
                      status: "error",
                      message: error.message,
                      code: error.code,
                    })
                  }
                />
              ) : isSynchronizationRetry(state.code) ? (
                <Button variant="outline" size="sm" onClick={() => void syncFinished()}>
                  <RefreshCwIcon data-icon="inline-start" /> Retry synchronization
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setGeneration((value) => value + 1)}
                >
                  <RefreshCwIcon data-icon="inline-start" /> Reload editor
                </Button>
              )}
            </div>
          )}
        </div>
        <MergeFieldLegend />
      </section>
      {state.status !== "finished" && (
        <p className="text-muted-foreground text-sm">
          Finish in the Dropbox Sign editor first. Sandra cannot force-save or
          roll back cross-origin editor state.
        </p>
      )}
    </div>
  );
}

function RestartPlacementButton({
  restartPlacement,
  onError,
}: {
  restartPlacement: TemplateEditorActions["restartPlacement"];
  onError(error: { code: string; message: string }): void;
}) {
  const router = useRouter();
  const sessions = useInitialEditorSessionStore();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await restartPlacement();
          if (!result.ok) {
            onError(result.error);
            return;
          }
          sessions.put(
            result.data.templateId,
            result.data.initialEditorSession,
          );
          if (result.data.cleanupAttention) {
            toast.warning(
              "The replacement is ready, but the template library still has cleanup to retry.",
              { duration: Infinity },
            );
          }
          router.replace(
            `/settings/esign-templates/${result.data.templateId}/edit`,
          );
        })
      }
    >
      <RefreshCwIcon data-icon="inline-start" />
      {pending ? "Restarting…" : "Restart placement"}
    </Button>
  );
}

function isSynchronizationRetry(code: string | undefined): boolean {
  return code === "PROVIDER_SYNC_PENDING" || code === "PROVIDER_SYNC_TIMEOUT";
}

export function InitialSessionEmbeddedTemplateEditor(
  props: Omit<Parameters<typeof EmbeddedTemplateEditor>[0], "initialSession">,
) {
  const sessions = useInitialEditorSessionStore();
  const consumed = useRef(false);
  const [initialSession, setInitialSession] = useState<
    EmbeddedTemplateSession | null | undefined
  >(undefined);

  useEffect(() => {
    if (consumed.current) return;
    consumed.current = true;
    setInitialSession(sessions.take(props.template.id));
  }, [props.template.id, sessions]);

  const preserveSessionForHistoryReturn = useCallback(
    (session: EmbeddedTemplateSession) =>
      sessions.put(props.template.id, session),
    [props.template.id, sessions],
  );

  if (initialSession === undefined) return null;
  return (
    <EmbeddedTemplateEditor
      {...props}
      initialSession={initialSession}
      preserveSessionForHistoryReturn={preserveSessionForHistoryReturn}
    />
  );
}

function EditorNotice({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-background/95 absolute inset-0 flex min-h-[520px] items-center justify-center p-6 text-center">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="text-muted-foreground mt-1 max-w-lg text-sm">{message}</p>
      </div>
    </div>
  );
}
