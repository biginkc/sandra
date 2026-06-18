"use client";

import { useRef, useState, type FormEvent } from "react";
import { SaveIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { createSavedFilter } from "@/app/(dashboard)/properties/_actions/saved-filters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { BlockStack } from "@/lib/prospects/filter-schema";

export type SaveFilterButtonProps = {
  orgId: string;
  currentBlocks: BlockStack;
};

export function SaveFilterButton({
  orgId,
  currentBlocks,
}: SaveFilterButtonProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const router = useRouter();

  if (currentBlocks.length === 0) return null;

  const reset = () => {
    setIsOpen(false);
    setName("");
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current) return;

    const trimmed = name.trim();
    if (!trimmed) {
      toast.error("Please enter a preset name.");
      return;
    }

    savingRef.current = true;
    setSaving(true);
    void (async () => {
      try {
        const result = await createSavedFilter({
          orgId,
          name: trimmed,
          filtersJson: { v: 1, blocks: currentBlocks },
          starred: true,
        });

        if (result.ok) {
          toast.success(`Saved preset "${trimmed}".`);
          reset();
          router.refresh();
        } else {
          toast.error(`Failed to save preset: ${result.error.message}`);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unexpected error";
        toast.error(`Failed to save preset: ${message}`);
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
  };

  if (!isOpen) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setIsOpen(true)}
        data-testid="save-filter-button"
      >
        <SaveIcon className="size-4" />
        Save filter
      </Button>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex min-w-[260px] max-w-full flex-wrap items-center gap-2"
      data-testid="save-filter-form"
    >
      <Input
        aria-label="Filter preset name"
        placeholder="Preset name"
        value={name}
        onChange={(event) =>
          setName((event.target as HTMLInputElement).value)
        }
        maxLength={100}
        className="h-8 w-[180px]"
        disabled={saving}
      />
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={reset}
        disabled={saving}
        aria-label="Cancel save filter"
      >
        <XIcon className="size-4" />
      </Button>
    </form>
  );
}
