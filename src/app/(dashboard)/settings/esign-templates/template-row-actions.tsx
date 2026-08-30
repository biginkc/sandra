"use client";

import { CopyIcon, Trash2Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateTemplateTitle } from "@/lib/esign/template-contract";

import type { EsignTemplateRow, TemplateLibraryActions } from "./types";

export function TemplateRowActions({ template, actions }: { template: EsignTemplateRow; actions?: TemplateLibraryActions }) {
  return (
    <>
      <DuplicateTemplateDialog template={template} actions={actions} />
      <DeleteTemplateDialog template={template} actions={actions} />
    </>
  );
}

export function DuplicateTemplateDialog({ template, actions }: { template: EsignTemplateRow; actions?: TemplateLibraryActions }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${template.name} (copy)`);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const validationError = validateTemplateTitle(name);
  const submit = () => actions && !validationError && startTransition(async () => {
    const result = await actions.duplicateTemplate(template.id, name.trim());
    if (!result.ok) return setError(result.error.message);
    setOpen(false);
    router.push(`/settings/esign-templates/${result.data.templateId}/edit`);
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="ghost" size="sm" onClick={() => { setName(`${template.name} (copy)`); setError(null); setOpen(true); }}><CopyIcon data-icon="inline-start" /> Duplicate</Button>
      <DialogContent>
        <DialogHeader><DialogTitle>Duplicate template</DialogTitle><DialogDescription>The original template stays unchanged. The copy opens in the editor when Dropbox Sign finishes preparing it.</DialogDescription></DialogHeader>
        <div className="space-y-2"><Label htmlFor={`duplicate-${template.id}`}>Copy name</Label><Input id={`duplicate-${template.id}`} value={name} onChange={(event) => setName(event.target.value)} /></div>
        {(error || validationError || !actions) && <p role="alert" className="text-destructive text-sm">{error ?? validationError ?? "Template actions are not connected yet."}</p>}
        <DialogFooter><DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose><Button onClick={submit} disabled={!actions || pending || Boolean(validationError)}>{pending ? "Duplicating…" : "Duplicate template"}</Button></DialogFooter>
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
