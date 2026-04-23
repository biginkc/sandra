"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";

import { createSequence } from "../actions";

export function CreateSequenceForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [appendOptOut, setAppendOptOut] = useState(true);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const r = await callAction(
        createSequence({
          name,
          description: description.trim() || null,
          append_opt_out: appendOptOut,
        }),
        {
          successMessage: "Sequence created",
          fallbackMessage: "Could not create sequence",
        },
      );
      if (r.ok) router.push(`/sequences/${r.data.id}/edit`);
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex max-w-xl flex-col gap-4">
      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Name</span>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder='e.g. "First touch new lead"'
          required
          maxLength={120}
        />
      </label>

      <label className="flex flex-col gap-1 text-sm">
        <span className="font-medium">Description</span>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this sequence is for (internal only, sellers never see this)"
        />
      </label>

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={appendOptOut}
          onChange={(e) => setAppendOptOut(e.target.checked)}
          className="mt-0.5"
        />
        <span className="flex-1">
          <span className="font-medium">Auto-append opt-out phrase</span>
          <span className="text-muted-foreground block text-xs">
            When on, SMS steps that don&apos;t already include &ldquo;STOP&rdquo; or the{" "}
            <code>{"{{opt_out}}"}</code> variable get a rotated opt-out phrase
            appended at send time.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending || !name.trim()}>
          Create
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => router.push("/sequences")}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
