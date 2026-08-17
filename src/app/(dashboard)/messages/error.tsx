"use client";

import { AlertCircleIcon, RotateCwIcon } from "lucide-react";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";

export default function MessagesError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Messages" }]}
        title="Messages"
        description="Live conversations and queued outbound messages."
      />
      <div
        className="flex min-h-72 flex-col items-center justify-center gap-4 rounded-xl border border-red-200 bg-red-50 p-8 text-center"
        role="alert"
        data-testid="messages-load-failure"
      >
        <AlertCircleIcon className="h-6 w-6 text-red-700" />
        <div>
          <h2 className="text-base font-black text-red-950">
            Couldn&apos;t load Messages
          </h2>
          <p className="mt-1 max-w-lg text-sm text-red-800">
            This is a load failure, not an empty Inbox or Outbox. Your
            conversations and queued messages may still exist.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          className="min-h-11 bg-white"
          onClick={reset}
        >
          <RotateCwIcon className="h-4 w-4" />
          Retry
        </Button>
      </div>
    </Page>
  );
}
