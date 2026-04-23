"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/errors/call-action";

import { createList } from "./actions";

const COLOR_PRESETS: { value: string; label: string }[] = [
  { value: "#3b82f6", label: "Blue" },
  { value: "#10b981", label: "Emerald" },
  { value: "#f59e0b", label: "Amber" },
  { value: "#ef4444", label: "Red" },
  { value: "#8b5cf6", label: "Violet" },
  { value: "#ec4899", label: "Pink" },
  { value: "#64748b", label: "Slate" },
];

export function CreateListForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>(COLOR_PRESETS[0].value);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || pending) return;
    startTransition(async () => {
      const result = await callAction(
        createList({
          name: trimmed,
          description: description.trim() || null,
          color,
        }),
        { successMessage: `Created list "${trimmed}"`, fallbackMessage: "Could not create list" },
      );
      if (result.ok) {
        setName("");
        setDescription("");
        router.refresh();
      }
    });
  };

  return (
    <div className="border-border flex flex-col gap-3 rounded-md border p-4">
      <div className="text-sm font-semibold">New list</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="list-new-name">Name</Label>
          <Input
            id="list-new-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Pre-Foreclosure"
            maxLength={80}
            disabled={pending}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="list-new-desc">Description (optional)</Label>
          <Input
            id="list-new-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short note about this cohort"
            maxLength={200}
            disabled={pending}
          />
        </div>
        <Button
          onClick={submit}
          disabled={pending || name.trim().length === 0}
          className="sm:h-10"
        >
          <PlusIcon className="mr-1 size-3.5" />
          {pending ? "Creating…" : "Create"}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Label className="text-muted-foreground text-xs">Color</Label>
        {COLOR_PRESETS.map((c) => (
          <button
            key={c.value}
            type="button"
            onClick={() => setColor(c.value)}
            aria-label={c.label}
            aria-pressed={color === c.value}
            className={`size-5 rounded-full border-2 ${
              color === c.value ? "border-foreground" : "border-transparent"
            }`}
            style={{ backgroundColor: c.value }}
            disabled={pending}
          />
        ))}
      </div>
    </div>
  );
}
