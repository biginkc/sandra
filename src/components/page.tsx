import { cn } from "@/lib/utils";

/**
 * Standard outer wrapper for every dashboard page. Owns the airy padding
 * (px-10/py-10 on desktop) + max-width clamp + vertical-stack rhythm so
 * each page file no longer needs to repeat `flex flex-col gap-X p-6`
 * boilerplate. Tweaking spacing is a one-file change here.
 */
export function Page({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Tight to the sidebar (24px gutter on md+) instead of 40px so
        // the content area visually anchors against the rail.
        "flex w-full flex-1 flex-col gap-8 px-4 py-6 md:px-6 md:py-8",
        className,
      )}
    >
      {children}
    </div>
  );
}
