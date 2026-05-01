"use client";

import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import { deleteTemplate } from "./actions";

type Props = {
  templateId: string;
  templateName: string;
  systemManaged?: boolean;
};

export function DeleteTemplateButton({ templateId, templateName, systemManaged }: Props) {
  const [pending, startTransition] = useTransition();

  const handleDelete = () => {
    if (!confirm(`Delete "${templateName}"? This can be recovered by an admin.`)) {
      return;
    }
    startTransition(async () => {
      const result = await callAction(deleteTemplate(templateId), {
        fallbackMessage: "Failed to delete template",
      });
      if (result.ok) {
        toast.success("Template deleted");
      }
    });
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleDelete}
      disabled={pending || systemManaged}
      title={systemManaged ? "System templates cannot be deleted" : undefined}
      className="text-destructive hover:text-destructive"
    >
      {pending ? "Deleting…" : "Delete"}
    </Button>
  );
}
