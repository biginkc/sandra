"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import { archiveSequence, updateSequence } from "./actions";

export function SequenceRowActions({
  sequenceId,
  isArchived,
}: {
  sequenceId: string;
  isArchived: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const onArchive = () => {
    if (!window.confirm("Archive this sequence? Active enrollments finish on schedule.")) {
      return;
    }
    startTransition(async () => {
      const r = await callAction(archiveSequence(sequenceId), {
        successMessage: "Sequence archived",
        fallbackMessage: "Could not archive sequence",
      });
      if (r.ok) router.refresh();
    });
  };

  const onRestore = () => {
    startTransition(async () => {
      const r = await callAction(
        updateSequence(sequenceId, { active: true }),
        {
          successMessage: "Sequence restored",
          fallbackMessage: "Could not restore sequence",
        },
      );
      if (r.ok) router.refresh();
    });
  };

  return (
    <div className="flex items-center justify-end gap-2">
      <Link href={`/sequences/${sequenceId}/edit`}>
        <Button variant="ghost" size="sm">
          Edit
        </Button>
      </Link>
      {isArchived ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onRestore}
          disabled={pending}
        >
          Restore
        </Button>
      ) : (
        <Button
          variant="outline"
          size="sm"
          onClick={onArchive}
          disabled={pending}
        >
          Archive
        </Button>
      )}
    </div>
  );
}
