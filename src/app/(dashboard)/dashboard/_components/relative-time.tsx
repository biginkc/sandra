import { formatDistanceToNowStrict } from "date-fns/formatDistanceToNowStrict";

import { cn } from "@/lib/utils";

type Props = {
  iso: string;
  /** Pre-computed boolean from the parent — keeps this component pure. */
  breached?: boolean;
  className?: string;
};

export function RelativeTime({ iso, breached = false, className }: Props) {
  const date = new Date(iso);
  return (
    <time
      dateTime={iso}
      className={cn(
        breached ? "text-red-600" : "text-muted-foreground",
        className,
      )}
    >
      {formatDistanceToNowStrict(date, { addSuffix: false })}
    </time>
  );
}

export function isOlderThan(iso: string, ms: number, nowMs: number): boolean {
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && nowMs - t > ms;
}
