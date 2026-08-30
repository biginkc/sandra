"use client";

import { CopyIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getTemplateTitleValidationError } from "@/lib/esign/template-contract";

import type { EsignTemplateRow, TemplateLibraryActions } from "./types";

export function TemplateRowActions({ template, actions }: { template: EsignTemplateRow; actions?: TemplateLibraryActions }) {
  return (
    <>
      <EditTemplateButton template={template} actions={actions} />
      <DuplicateTemplateDialog template={template} actions={actions} />
      <DeleteTemplateDialog template={template} actions={actions} />
    </>
  );
}

function EditTemplateButton({ template, actions }: { template: EsignTemplateRow; actions?: TemplateLibraryActions }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const edit = () => actions && startTransition(async () => {
    setError(null);
    const result = await actions.beginEditRevision(template.id);
    if (!result.ok) return setError(result.error.message);
    if (result.data.readiness === "ready") router.push(`/settings/esign-templates/${result.data.templateId}/edit`);
    else router.refresh();
  });
  return (
    <div>
      <Button variant="ghost" size="sm" onClick={edit} disabled={!actions || pending}><PencilIcon data-icon="inline-start" />{pending ? "Preparing…" : "Edit"}</Button>
      {error && <p role="alert" className="text-destructive max-w-52 text-xs">{error}</p>}
    </div>
  );
}

export function DuplicateTemplateDialog({ template, actions }: { template: EsignTemplateRow; actions?: TemplateLibraryActions }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${template.name} (copy)`);
  const [error, setError] = useState<string | null>(null);
  const [copyId, setCopyId] = useState<string | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [checkingReadiness, setCheckingReadiness] = useState(false);
  const [routed, setRouted] = useState(false);
  const [pending, startTransition] = useTransition();
  const mountedRef = useRef(true);
  const dialogGenerationRef = useRef(0);
  const dialogActiveRef = useRef(false);
  const readinessPromiseRef = useRef<Promise<void> | null>(null);
  const routedRef = useRef(false);
  const validationError = getTemplateTitleValidationError(name);
  const checkReadiness = useCallback(() => {
    if (!actions || !copyId || routedRef.current) return Promise.resolve();
    if (readinessPromiseRef.current) return readinessPromiseRef.current;
    const generation = dialogGenerationRef.current;
    if (mountedRef.current) setCheckingReadiness(true);
    const request = actions.checkEditorReadiness(copyId).then((result) => {
      if (!mountedRef.current || !dialogActiveRef.current || generation !== dialogGenerationRef.current || routedRef.current) return;
      if (!result.ok) {
        setError(result.error.message);
        setPollAttempt(3);
        return;
      }
      if (result.data.readiness === "ready") {
        routedRef.current = true;
        setRouted(true);
        setOpen(false);
        router.push(`/settings/esign-templates/${copyId}/edit`);
        return;
      }
      setPollAttempt((attempt) => attempt + 1);
    }).finally(() => {
      if (readinessPromiseRef.current === request) readinessPromiseRef.current = null;
      if (mountedRef.current && generation === dialogGenerationRef.current && !routedRef.current) setCheckingReadiness(false);
    });
    readinessPromiseRef.current = request;
    return request;
  }, [actions, copyId, router]);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!open || !copyId || pollAttempt >= 3 || error) return;
    const timeout = window.setTimeout(() => void checkReadiness(), 1_500);
    return () => window.clearTimeout(timeout);
  }, [checkReadiness, copyId, error, open, pollAttempt]);

  const submit = () => actions && !validationError && startTransition(async () => {
    const result = await actions.duplicateTemplate(template.id, name.trim());
    if (!result.ok) return setError(result.error.message);
    if (result.data.readiness === "ready") {
      setOpen(false);
      router.push(`/settings/esign-templates/${result.data.templateId}/edit`);
      return;
    }
    setCopyId(result.data.templateId);
    setPollAttempt(0);
    setError(null);
  });
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) { dialogActiveRef.current = false; dialogGenerationRef.current += 1; } setOpen(nextOpen); }}>
      <Button variant="ghost" size="sm" onClick={() => { dialogGenerationRef.current += 1; dialogActiveRef.current = true; routedRef.current = false; readinessPromiseRef.current = null; setRouted(false); setCheckingReadiness(false); setName(`${template.name} (copy)`); setError(null); setCopyId(null); setPollAttempt(0); setOpen(true); }}><CopyIcon data-icon="inline-start" /> Duplicate</Button>
      <DialogContent>
        <DialogHeader><DialogTitle>Duplicate template</DialogTitle><DialogDescription>The original template stays unchanged. The copy opens in the editor when Dropbox Sign finishes preparing it.</DialogDescription></DialogHeader>
        {copyId ? (
          <div className="border-border bg-muted/40 rounded-lg border p-4" role="status">
            <p className="font-medium">Copy is still preparing</p>
            <p className="text-muted-foreground mt-1 text-sm">Dropbox Sign has the copy, but its editor is not ready yet. Sandra will check a few times automatically.</p>
          </div>
        ) : <div className="space-y-2"><Label htmlFor={`duplicate-${template.id}`}>Copy name</Label><Input id={`duplicate-${template.id}`} value={name} onChange={(event) => setName(event.target.value)} /></div>}
        {(error || (!copyId && validationError) || !actions) && <p role="alert" className="text-destructive text-sm">{error ?? validationError ?? "Template actions are not connected yet."}</p>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Close</DialogClose>
          {copyId ? <Button variant="outline" onClick={() => { setError(null); setPollAttempt(0); void checkReadiness(); }} disabled={!actions || pending || checkingReadiness || routed}>{checkingReadiness ? "Checking…" : "Reload"}</Button> : <Button onClick={submit} disabled={!actions || pending || Boolean(validationError)}>{pending ? "Duplicating…" : "Duplicate template"}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteTemplateDialog({ template, actions }: { template: EsignTemplateRow; actions?: TemplateLibraryActions }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRecentSends, setConfirmRecentSends] = useState(template.recentSendCount30d > 0);
  const [pending, startTransition] = useTransition();
  const submit = () => actions && startTransition(async () => {
    const result = await actions.deleteTemplate(template.id, confirmRecentSends);
    if (!result.ok) {
      if (result.error.code === "TEMPLATE_RECENTLY_USED") setConfirmRecentSends(true);
      return setError(result.error.message);
    }
    setOpen(false);
    router.refresh();
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="sm" className="text-destructive" onClick={() => { setConfirmRecentSends(template.recentSendCount30d > 0); setError(null); setOpen(true); }}><Trash2Icon data-icon="inline-start" /> Delete</Button>
      <DialogContent>
        <DialogHeader><DialogTitle>Delete {template.name}?</DialogTitle><DialogDescription>The reusable template will be removed. Existing contract records and saved PDFs stay in Sandra.</DialogDescription></DialogHeader>
        {confirmRecentSends && <div className="border-alert-warning/40 bg-alert-warning/10 rounded-lg border p-3 text-sm">{template.recentSendCount30d > 0 ? `This template was used for ${template.recentSendCount30d} contract${template.recentSendCount30d === 1 ? "" : "s"} in the last 30 days.` : "This template was used recently."} Deleting it will not remove existing contract history or signed PDFs.</div>}
        {(error || !actions) && <p role="alert" className="text-destructive text-sm">{error ?? "Template actions are not connected yet."}</p>}
        <DialogFooter><DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose><Button variant="destructive" onClick={submit} disabled={!actions || pending}>{pending ? "Deleting…" : "Delete template"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
