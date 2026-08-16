"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { retryCsvImportJob } from "../import/actions";

export function RetryCsvImportButton({ jobId }: { jobId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <Button
      variant="outline"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        const result = await retryCsvImportJob(jobId);
        setPending(false);
        if (result.ok) {
          toast.success("Import resumed.");
          router.refresh();
        } else {
          toast.error(result.error.message);
        }
      }}
    >
      {pending ? "Starting retry…" : "Retry import"}
    </Button>
  );
}
