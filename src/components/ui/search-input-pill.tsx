import { Search } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SearchInputPillProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "className">,
    React.RefAttributes<HTMLInputElement> {
  /** Outer wrapper class override — width, margin, etc. */
  wrapperClassName?: string;
  /** Magnifying glass icon class override. */
  iconClassName?: string;
}

/**
 * Pill-shaped search input with a leading magnifying glass.
 *
 * @example
 * <SearchInputPill
 *   placeholder="Search by property, owner, or status..."
 *   wrapperClassName="w-96"
 * />
 */
export function SearchInputPill({
  wrapperClassName,
  iconClassName,
  type = "text",
  ref,
  ...props
}: SearchInputPillProps) {
  return (
    <div
      data-slot="search-input-pill"
      className={cn("relative w-full", wrapperClassName)}
    >
      <Search
        className={cn(
          "absolute left-4 top-1/2 -translate-y-1/2 size-4 text-muted-foreground pointer-events-none",
          iconClassName
        )}
      />
      <input
        ref={ref}
        type={type}
        className="w-full pl-12 pr-4 py-2 border-none rounded-full text-sm bg-secondary placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        {...props}
      />
    </div>
  );
}
