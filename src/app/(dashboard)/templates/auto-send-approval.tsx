"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callAction } from "@/lib/errors/call-action";

import { type TemplateRow } from "./actions";
import { setTemplateAutoSendApproval } from "./auto-reply-actions";

type Props = {
  template: Pick<TemplateRow, "id" | "name" | "content" | "approved_for_auto_send" | "approved_at">;
  /** Only an org owner may change approval; everyone else sees it read-only. */
  isOwner: boolean;
};

/**
 * "Approved for automatic replies": the only gate between a library template
 * and unsupervised sends. Turning it on shows the exact text and records who
 * approved it and when (server side). Editing the text later removes the
 * approval, so what is approved is always what is sent.
 */
export function AutoSendApproval({ template, isOwner }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();
  const approved = template.approved_for_auto_send === true;

  if (!isOwner) {
    return approved ? (
      <Badge variant="secondary" data-testid={`auto-send-badge-${template.id}`}>
        Approved for automatic replies
      </Badge>
    ) : null;
  }

  const approve = () => {
    startTransition(async () => {
      const result = await callAction(
        setTemplateAutoSendApproval({
          templateId: template.id,
          approved: true,
          expectedContent: template.content,
        }),
        { fallbackMessage: "Failed to approve template" },
      );
      if (result.ok) {
        toast.success("Approved for automatic replies");
        setConfirming(false);
      }
    });
  };

  const revoke = () => {
    startTransition(async () => {
      const result = await callAction(
        setTemplateAutoSendApproval({
          templateId: template.id,
          approved: false,
          expectedContent: null,
        }),
        { fallbackMessage: "Failed to remove approval" },
      );
      if (result.ok) toast.success("No longer approved for automatic replies");
    });
  };

  return (
    <>
      <label className="flex items-center gap-1.5 text-xs whitespace-nowrap">
        <input
          type="checkbox"
          role="switch"
          aria-label={`Approved for automatic replies: ${template.name}`}
          data-testid={`auto-send-toggle-${template.id}`}
          checked={approved}
          disabled={pending}
          onChange={(e) => {
            if (e.target.checked) setConfirming(true);
            else revoke();
          }}
        />
        <span>Approved for automatic replies</span>
      </label>

      <Dialog open={confirming} onOpenChange={(open) => !pending && setConfirming(open)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Approve for automatic replies?</DialogTitle>
            <DialogDescription>
              Once approved, Sandra can send this exact text to sellers without
              anyone reviewing it, whenever a label mapped to it fires. If you
              edit the text later, the approval is removed.
            </DialogDescription>
          </DialogHeader>
          <blockquote
            data-testid="approval-exact-text"
            className="max-h-64 overflow-y-auto rounded-md border bg-muted/40 p-3 text-sm whitespace-pre-wrap"
          >
            {template.content}
          </blockquote>
          <DialogFooter showCloseButton={false}>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              Cancel
            </Button>
            <Button onClick={approve} disabled={pending} data-testid="approval-confirm">
              {pending ? "Approving…" : "Approve this exact text"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
