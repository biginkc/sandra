"use client";

import { ArchiveIcon, ArchiveRestoreIcon, SendIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { callAction } from "@/lib/errors/call-action";

import {
  archiveCampaign,
  launchCampaign,
  unarchiveCampaign,
} from "./actions";

type Props = {
  id: string;
  name: string;
  status: "active" | "launching" | "paused" | "completed" | "archived";
  archived: boolean;
};

export function CampaignRowActions({
  id,
  name,
  status,
  archived,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const canLaunch = !archived && (status === "active" || status === "paused");
  const canArchive = !archived && status !== "launching";

  const handleLaunch = () => {
    if (
      !window.confirm(
        `Launch "${name}" now?\n\nThis is a one-shot SMS blast. Sandra will queue outbound messages for every prospect in this saved audience.`,
      )
    ) {
      return;
    }

    startTransition(async () => {
      const result = await callAction(launchCampaign(id), {
        fallbackMessage: "Could not launch campaign",
      });
      if (!result.ok) return;

      if (result.data.alreadyLaunched) {
        toast.warning(`"${name}" was already launched.`);
      } else if (result.data.deferred) {
        toast.success(
          `Launching "${name}" in the background for ${result.data.recipientCount.toLocaleString()} recipients.`,
        );
      } else {
        toast.success(
          `Launched "${name}" for ${result.data.recipientCount.toLocaleString()} recipients.`,
        );
      }

      router.refresh();
    });
  };

  const handleArchiveToggle = () => {
    startTransition(async () => {
      const result = await callAction(
        archived ? unarchiveCampaign(id) : archiveCampaign(id),
        {
          successMessage: archived
            ? `Restored "${name}"`
            : `Archived "${name}"`,
          fallbackMessage: archived
            ? "Could not restore campaign"
            : "Could not archive campaign",
        },
      );
      if (result.ok) router.refresh();
    });
  };

  return (
    <div className="flex justify-end gap-2">
      {archived ? null : canLaunch ? (
        <Button
          variant="outline"
          size="sm"
          onClick={handleLaunch}
          disabled={pending}
          aria-label="Launch campaign"
        >
          <SendIcon className="mr-1 size-3.5" />
          {pending ? "Launching…" : "Launch"}
        </Button>
      ) : (
        <span className="text-muted-foreground self-center text-xs italic">
          {status === "launching"
            ? "Launching"
            : status === "completed"
              ? "Sent"
              : "Locked"}
        </span>
      )}

      {(archived || canArchive) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={handleArchiveToggle}
          disabled={pending}
          aria-label={archived ? "Restore campaign" : "Archive campaign"}
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
      )}
    </div>
  );
}
