"use client";

import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";
import {
  VOICEMAIL_SCRIPT_MAX_CHARS,
  voicemailScriptProblem,
} from "@/lib/sequences/voicemail-drop-step-config";

import {
  createVoicemailTemplate,
  deleteVoicemailTemplate,
  updateVoicemailTemplate,
  type VoicemailTemplateRow,
} from "./voicemail-template-actions";

/**
 * Saved voicemail scripts, grouped. A drip voicemail step can rotate among
 * the scripts in one group. Separate from SMS templates on purpose.
 */
export function VoicemailTemplatesSection({ templates }: { templates: VoicemailTemplateRow[] }) {
  const [editing, setEditing] = useState<VoicemailTemplateRow | "new" | null>(null);
  const groups = [...new Set(templates.map((t) => t.category))].sort();
  return (
    <section className="flex flex-col gap-3" data-testid="voicemail-templates-section">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Voicemail scripts</h2>
          <p className="text-muted-foreground text-sm">
            Scripts read aloud by voicemail drop steps. Put several in one group and a drip step can rotate between them.
          </p>
        </div>
        <Button type="button" size="sm" onClick={() => setEditing("new")}>New voicemail script</Button>
      </div>
      {templates.length === 0 ? (
        <p className="text-muted-foreground text-sm">No voicemail scripts yet.</p>
      ) : (
        groups.map((group) => (
          <div key={group} className="rounded-md border">
            <p className="bg-muted/40 border-b px-3 py-1.5 text-sm font-medium">{group}</p>
            <ul className="divide-y">
              {templates.filter((t) => t.category === group).map((t) => (
                <VoicemailTemplateItem key={t.id} template={t} onEdit={() => setEditing(t)} />
              ))}
            </ul>
          </div>
        ))
      )}
      {editing ? (
        <VoicemailTemplateDialog
          template={editing === "new" ? null : editing}
          groups={groups}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function VoicemailTemplateItem({ template, onEdit }: { template: VoicemailTemplateRow; onEdit: () => void }) {
  const [pending, startTransition] = useTransition();
  const problem = voicemailScriptProblem(template.content);
  const onDelete = () => {
    if (!confirm(`Delete "${template.name}"?`)) return;
    startTransition(async () => {
      const result = await callAction(deleteVoicemailTemplate(template.id), {
        fallbackMessage: "Could not delete voicemail script",
      });
      if (result.ok) toast.success("Voicemail script deleted");
    });
  };
  return (
    <li className="flex items-start gap-3 px-3 py-2 text-sm">
      <div className="min-w-0 flex-1">
        <p className="font-medium">{template.name}</p>
        <p className="text-muted-foreground truncate" title={template.content}>{template.content}</p>
        {problem ? <p className="text-destructive text-xs">{problem}</p> : null}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
      <Button type="button" variant="ghost" size="sm" onClick={onDelete} disabled={pending}
        className="text-destructive hover:text-destructive">
        {pending ? "Deleting…" : "Delete"}
      </Button>
    </li>
  );
}

function VoicemailTemplateDialog({ template, groups, onClose }: {
  template: VoicemailTemplateRow | null;
  groups: string[];
  onClose: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [category, setCategory] = useState(template?.category ?? "");
  const [content, setContent] = useState(template?.content ?? "");
  const [pending, startTransition] = useTransition();
  const ids = { name: useId(), group: useId(), script: useId(), list: useId() };
  const length = content.trim().length;
  const problem = content.trim() ? voicemailScriptProblem(content) : null;
  const canSave = Boolean(name.trim() && category.trim() && content.trim() && !problem);

  const onSave = () => {
    if (!canSave) return;
    startTransition(async () => {
      const input = { name, category, content };
      const result = template
        ? await callAction(updateVoicemailTemplate(template.id, input), { fallbackMessage: "Could not save voicemail script" })
        : await callAction(createVoicemailTemplate(input), { fallbackMessage: "Could not save voicemail script" });
      if (result.ok) {
        toast.success("Voicemail script saved");
        onClose();
      }
    });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{template ? "Edit voicemail script" : "New voicemail script"}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <label htmlFor={ids.name} className="flex flex-col gap-1">
            <span className="font-medium">Name</span>
            <Input id={ids.name} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </label>
          <label htmlFor={ids.group} className="flex flex-col gap-1">
            <span className="font-medium">Group</span>
            <Input id={ids.group} value={category} onChange={(e) => setCategory(e.target.value)} list={ids.list} maxLength={120} />
            <datalist id={ids.list}>{groups.map((g) => <option key={g} value={g} />)}</datalist>
          </label>
          <label htmlFor={ids.script} className="flex flex-col gap-1">
            <span className="font-medium">Script</span>
            <textarea id={ids.script} value={content} onChange={(e) => setContent(e.target.value)} rows={5}
              className="border-input rounded-md border px-2 py-1.5 font-mono text-sm" />
          </label>
          <span className={`text-xs ${length > VOICEMAIL_SCRIPT_MAX_CHARS ? "text-destructive font-semibold" : "text-muted-foreground"}`} aria-live="polite">
            {length} / {VOICEMAIL_SCRIPT_MAX_CHARS.toLocaleString("en-US")}
          </span>
          {problem ? <span className="text-destructive text-xs" role="alert">{problem}</span> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="button" onClick={onSave} disabled={!canSave || pending}>{pending ? "Saving…" : "Save"}</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
