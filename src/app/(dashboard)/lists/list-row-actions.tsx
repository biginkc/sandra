"use client";

import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import { archiveList, unarchiveList } from "./actions";

type Props = {
  id: string;
  name: string;
  archived: boolean;
};

export function ListRowActions({ id, name, archived }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const toggle = () => {
    startTransition(async () => {
      const result = await callAction(
        archived ? unarchiveList(id) : archiveList(id),
        {
          successMessage: archived
            ? `Restored "${name}"`
            : `Archived "${name}"`,
          fallbackMessage: archived
            ? "Could not restore list"
            : "Could not archive list",
        },
      );
      if (result.ok) router.refresh();
    });
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={toggle}
      disabled={pending}
      aria-label={archived ? "Restore list" : "Archive list"}
    >
      {archived ? (
        <>
          <ArchiveRestoreIcon className="mr-1 size-3.5" />
          Restore
        </>
      ) : (
        <>
          <ArchiveIcon className="mr-1 size-3.5" />
          Archive
        </>
      )}
    </Button>
  );
}
