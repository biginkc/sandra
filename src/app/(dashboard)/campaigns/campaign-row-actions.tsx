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
  previewCampaignLaunch,
  unarchiveCampaign,
} from "./actions";

type Props = {
  id: string;
  name: string;
  status:
    | "active"
    | "launching"
    | "paused"
    | "completed"
    | "failed"
    | "archived";
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

  const canLaunch = !archived && status === "active";
  const canArchive = !archived && status !== "launching";

  const handleLaunch = () => {
    startTransition(async () => {
      const preview = await callAction(previewCampaignLaunch(id), {
        fallbackMessage: "Could not preview campaign launch",
      });
      if (!preview.ok) return;

      const p = preview.data;
      const lines = [
        `Launch "${name}" now?`,
        "",
        `${p.estimatedQueueableCount.toLocaleString()} of ${p.recipientCount.toLocaleString()} recipients are expected to queue.`,
      ];
      if (p.skipIfContacted) {
        lines.push(
          `${p.successfulPriorContactCount.toLocaleString()} will be skipped because they already have a successful prior SMS.`,
        );
      }
      if (p.priorFailedAttemptCount > 0) {
        lines.push(
          `${p.priorFailedAttemptCount.toLocaleString()} have prior failed SMS attempts; those are not treated as contacted.`,
        );
      }
      const blocked: string[] = [];
      if (p.missingContactCount > 0) {
        blocked.push(`${p.missingContactCount.toLocaleString()} missing contact/phone`);
      }
      if (p.landlineCount > 0) {
        blocked.push(`${p.landlineCount.toLocaleString()} landline`);
      }
      if (p.unknownLineTypeCount > 0) {
        blocked.push(`${p.unknownLineTypeCount.toLocaleString()} unknown phone type`);
      }
      if (p.optedOutCount > 0) {
        blocked.push(`${p.optedOutCount.toLocaleString()} opted out`);
      }
      if (blocked.length > 0) {
        lines.push(`Other expected skips: ${blocked.join(", ")}.`);
      }
      lines.push("", "Quiet hours and opt-outs are re-checked again before each send.");

      if (!window.confirm(lines.join("\n"))) {
        return;
      }

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
          {pending ? "Checking…" : "Launch"}
        </Button>
      ) : (
        <span className="text-muted-foreground self-center text-xs italic">
          {status === "launching"
            ? "Launching"
            : status === "completed"
              ? "Queue built"
              : status === "failed"
                ? "Queue failed"
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
