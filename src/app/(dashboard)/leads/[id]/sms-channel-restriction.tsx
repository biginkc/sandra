import { MessageSquareOffIcon } from "lucide-react";

import { cn } from "@/lib/utils";

export function SmsEntryPointGate({
  restricted,
  placement,
  restrictionLabel,
  restrictionDetail,
  children,
}: {
  restricted: boolean;
  placement: "header" | "inline";
  restrictionLabel: string;
  restrictionDetail: string;
  children: React.ReactNode;
}) {
  if (!restricted) return children;
  return (
    <SmsChannelRestriction
      placement={placement}
      restrictionLabel={restrictionLabel}
      restrictionDetail={restrictionDetail}
    />
  );
}

export function SmsChannelRestriction({
  placement,
  restrictionLabel,
  restrictionDetail,
}: {
  placement: "header" | "inline";
  restrictionLabel: string;
  restrictionDetail: string;
}) {
  return (
    <div
      className={cn(
        "border-amber-300 bg-amber-50 text-amber-950 flex gap-2 rounded-md border",
        placement === "header"
          ? "min-h-9 items-center px-3 py-1.5 text-xs font-semibold"
          : "mt-3 items-start p-3 text-sm",
      )}
      role="status"
      data-testid={`sms-channel-restriction-${placement}`}
    >
      <MessageSquareOffIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        <strong>SMS disabled.</strong>{" "}
        {placement === "inline"
          ? restrictionDetail
          : `${restrictionLabel} · non-SMS work remains available`}
      </span>
    </div>
  );
}
