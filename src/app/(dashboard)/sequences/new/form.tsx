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
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const r = await callAction(
        createSequence({
          name,
          description: description.trim() || null,
        }),
        {
          successMessage: "Drip created",
          fallbackMessage: "Could not create drip",
        },
      );
      if (r.ok) router.push(`/sequences/${r.data.id}/edit?new=1`);
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
          placeholder="What this drip is for (internal only, sellers never see this)"
        />
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
