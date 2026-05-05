"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callAction } from "@/lib/errors/call-action";

import { bulkQueueSms, listSmsTemplateCategories } from "./actions";

type Category = { category: string; count: number };

type Props = {
  open: boolean;
  propertyIds: string[];
  onClose: () => void;
  onQueued: (succeeded: number) => void;
};

export function BulkSmsModal({ open, propertyIds, onClose, onQueued }: Props) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<string>("");
  const [customBody, setCustomBody] = useState("");
  const [mode, setMode] = useState<"category" | "custom">("category");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    listSmsTemplateCategories().then((result) => {
      if (result.ok) {
        setCategories(result.data);
        setSelectedCategory(result.data[0]?.category ?? "");
      }
    });
  }, [open]);

  const handleSend = () => {
    const opts =
      mode === "category"
        ? { templateCategory: selectedCategory }
        : { body: customBody.trim() };

    if (mode === "category" && !selectedCategory) {
      toast.error("Pick a template category first.");
      return;
    }
    if (mode === "custom" && !customBody.trim()) {
      toast.error("Enter a message body.");
      return;
    }

    startTransition(async () => {
      const result = await callAction(bulkQueueSms(propertyIds, opts), {
        fallbackMessage: "Bulk SMS failed",
      });
      if (result.ok) {
        const { succeeded, skipped, failed } = result.data;
        const parts: string[] = [];
        if (succeeded > 0)
          parts.push(`${succeeded} message${succeeded === 1 ? "" : "s"} queued`);
        if (skipped > 0) parts.push(`${skipped} skipped`);
        if (failed.length > 0) parts.push(`${failed.length} failed`);
        if (failed.length > 0) {
          toast.warning(parts.join(" · "), {
            description: failed[0].message,
          });
        } else {
          toast.success(parts.join(" · ") || "Done");
        }
        onQueued(succeeded);
        onClose();
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            Bulk SMS — {propertyIds.length} prospect
            {propertyIds.length === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Mode toggle */}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setMode("category")}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                mode === "category"
                  ? "bg-primary text-primary-foreground border-transparent"
                  : "text-muted-foreground"
              }`}
            >
              Template pool
            </button>
            <button
              type="button"
              onClick={() => setMode("custom")}
              className={`rounded-md border px-3 py-1.5 text-sm ${
                mode === "custom"
                  ? "bg-primary text-primary-foreground border-transparent"
                  : "text-muted-foreground"
              }`}
            >
              Custom message
            </button>
          </div>

          {mode === "category" ? (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Template category</label>
              {categories.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No SMS templates found. Add some in Settings.
                </p>
              ) : (
                <select
                  value={selectedCategory}
                  onChange={(e) => setSelectedCategory(e.target.value)}
                  className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                >
                  {categories.map((c) => (
                    <option key={c.category} value={c.category}>
                      {c.category} ({c.count} template{c.count === 1 ? "" : "s"})
                    </option>
                  ))}
                </select>
              )}
            </div>
          ) : (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Message body</label>
              <textarea
                value={customBody}
                onChange={(e) => setCustomBody(e.target.value)}
                rows={4}
                placeholder="Hi {first_name}, I'm interested in your property…"
                className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
              />
            </div>
          )}

          <p className="text-muted-foreground text-xs">
            Messages are queued with 18-second pacing and sent by the cron
            after consent + quiet-hours checks pass.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSend} disabled={pending}>
            {pending ? "Queuing…" : `Queue ${propertyIds.length} message${propertyIds.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
