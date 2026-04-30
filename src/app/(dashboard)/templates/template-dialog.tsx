"use client";

import { useRef, useState, useTransition, useCallback } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { callAction } from "@/lib/errors/call-action";
import { renderTemplate } from "@/lib/templates/render";
import {
  TEMPLATE_VARIABLES,
  buildSampleVars,
} from "@/lib/templates/variables";

import {
  createTemplate,
  updateTemplate,
  type TemplateRow,
} from "./actions";

const PRESET_CATEGORIES = [
  "Cold Outreach",
  "Follow Up",
  "Appointment",
  "General",
];

const sampleVars = buildSampleVars();

type Props = {
  mode: "create" | "edit";
  template?: TemplateRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// SMS character counting
function getSmsInfo(text: string) {
  // eslint-disable-next-line no-control-regex
  const isGsm7 = /^[\x00-\x7f¡£¤¥§¿ÄÅÆÇÉÑÖØÜßàäåæèéìñòöøùü\n\r]*$/.test(
    text,
  );
  const charLimit = isGsm7 ? 160 : 70;
  const multiLimit = isGsm7 ? 153 : 67;
  const len = text.length;
  const segments = len <= charLimit ? 1 : Math.ceil(len / multiLimit);
  return { len, segments, encoding: isGsm7 ? "GSM-7" : "UCS-2", charLimit };
}

export function TemplateDialog({ mode, template, open, onOpenChange }: Props) {
  const [name, setName] = useState(template?.name ?? "");
  const [content, setContent] = useState(template?.content ?? "");
  const [category, setCategory] = useState(template?.category ?? "General");
  const [pending, startTransition] = useTransition();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const smsInfo = getSmsInfo(content);
  const preview = renderTemplate(content, sampleVars);

  const insertVariable = useCallback(
    (varName: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const tag = `{{${varName}}}`;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const newContent =
        content.slice(0, start) + tag + content.slice(end);
      setContent(newContent);
      // Restore cursor after the inserted tag
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + tag.length;
        ta.setSelectionRange(pos, pos);
      });
    },
    [content],
  );

  const handleSubmit = () => {
    startTransition(async () => {
      if (mode === "create") {
        const result = await callAction(
          createTemplate({ name, content, category }),
          { fallbackMessage: "Failed to create template" },
        );
        if (result.ok) {
          toast.success("Template created");
          onOpenChange(false);
        }
      } else if (template) {
        const result = await callAction(
          updateTemplate(template.id, { name, content, category }),
          { fallbackMessage: "Failed to update template" },
        );
        if (result.ok) {
          toast.success("Template updated");
          onOpenChange(false);
        }
      }
    });
  };

  // Group variables for the picker
  const grouped = TEMPLATE_VARIABLES.reduce(
    (acc, v) => {
      if (!acc[v.group]) acc[v.group] = [];
      acc[v.group].push(v);
      return acc;
    },
    {} as Record<string, typeof TEMPLATE_VARIABLES[number][]>,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "create" ? "New template" : `Edit: ${template?.name}`}
          </DialogTitle>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-2">
          {/* Left column: Editor */}
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="template-name">Name</Label>
              <Input
                id="template-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Cold Intro v1"
                maxLength={120}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="template-category">Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v ?? "General")}>
                <SelectTrigger id="template-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESET_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="template-content">Content</Label>
              <textarea
                ref={textareaRef}
                id="template-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Hey {{first_name | there}}, this is {{my_first_name}} with {{company_name}}…"
                rows={8}
                className="border-input placeholder:text-muted-foreground focus-visible:ring-ring min-h-[120px] w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:ring-1 focus-visible:outline-none"
              />
            </div>

            {/* Variable picker */}
            <div className="flex flex-col gap-2">
              <Label className="text-xs text-muted-foreground">
                Insert variable at cursor
              </Label>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(grouped).map(([group, vars]) => (
                  <div key={group} className="flex flex-wrap items-center gap-1">
                    <span className="text-muted-foreground mr-1 text-[10px] font-bold uppercase tracking-widest">
                      {group}
                    </span>
                    {vars.map((v) => (
                      <Button
                        key={v.name}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() => insertVariable(v.name)}
                      >
                        {v.label}
                      </Button>
                    ))}
                  </div>
                ))}
              </div>
            </div>

            {/* Character counter */}
            <div className="flex items-center gap-3 text-xs">
              <div className="bg-muted h-2 flex-1 rounded-full overflow-hidden">
                <div
                  className="bg-foreground h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${Math.min(100, (smsInfo.len / smsInfo.charLimit) * 100)}%`,
                  }}
                />
              </div>
              <span
                className={
                  smsInfo.len > smsInfo.charLimit * 3
                    ? "text-destructive"
                    : "text-muted-foreground"
                }
              >
                {smsInfo.len} chars · {smsInfo.segments}{" "}
                {smsInfo.segments === 1 ? "segment" : "segments"} ·{" "}
                {smsInfo.encoding}
              </span>
            </div>
          </div>

          {/* Right column: Preview */}
          <div className="flex flex-col gap-2">
            <Label className="text-xs text-muted-foreground">
              Live preview (sample data)
            </Label>
            <div className="border-border bg-muted/30 min-h-[200px] rounded-xl border p-4">
              <div className="bg-card max-w-[280px] rounded-2xl rounded-bl-sm px-4 py-3 text-sm shadow-sm">
                {preview || (
                  <span className="text-muted-foreground italic">
                    Start typing to see preview…
                  </span>
                )}
              </div>
              <div className="text-muted-foreground mt-4 text-[10px]">
                <span className="font-semibold">Sample data:</span>{" "}
                {TEMPLATE_VARIABLES.map((v) => `${v.label}: ${v.example}`).join(
                  " · ",
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 pt-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!name.trim() || !content.trim() || pending}
          >
            {pending
              ? "Saving…"
              : mode === "create"
                ? "Create template"
                : "Save changes"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
