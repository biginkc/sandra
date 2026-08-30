import { FileTextIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";

import type { TemplateEditorData } from "../../types";

export function TemplateFileStrip({ template }: { template: TemplateEditorData }) {
  const facts = [
    formatBytes(template.sourceSizeBytes),
    template.pageCount === null
      ? null
      : `${template.pageCount} page${template.pageCount === 1 ? "" : "s"}`,
    template.fieldCount === null
      ? null
      : `${template.fieldCount} field${template.fieldCount === 1 ? "" : "s"}`,
  ].filter(Boolean);

  return (
    <div className="bg-muted/60 flex flex-wrap items-center gap-3 px-5 py-3.5">
      <div className="bg-muted text-muted-foreground flex size-9 items-center justify-center rounded-lg">
        <FileTextIcon aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{template.sourceFilename}</p>
        <p className="text-muted-foreground text-xs">{facts.join(" · ")}</p>
      </div>
      <Badge variant="outline">Test mode</Badge>
    </div>
  );
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
