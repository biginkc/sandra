"use client"

import * as React from "react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import { DayPicker, type DayButtonProps } from "react-day-picker"

import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"

/**
 * Thin wrapper around react-day-picker v10, styled with the same semantic
 * tokens + `buttonVariants` used by every other `ui/*.tsx` primitive (see
 * `select.tsx` / `popover.tsx` neighbors). No new design system — the day
 * grid borrows `ghost`/ `default` button classes so selected/today states
 * match the rest of the app instead of inventing calendar-specific colors.
 */
function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: React.ComponentProps<typeof DayPicker>) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-2", className)}
      classNames={{
        root: "w-fit",
        months: "flex flex-col gap-3",
        month: "flex flex-col gap-3",
        nav: "flex items-center justify-between",
        button_previous: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute left-0",
        ),
        button_next: cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "absolute right-0",
        ),
        month_caption: "relative flex h-8 items-center justify-center",
        caption_label: "text-sm font-medium text-foreground",
        month_grid: "w-full border-collapse",
        weekdays: "flex",
        weekday:
          "w-8 text-center text-xs font-medium text-muted-foreground",
        weeks: "flex flex-col gap-1 mt-1",
        week: "flex w-full",
        day: "relative size-8 p-0 text-center text-sm",
        day_button: cn(
          buttonVariants({ variant: "ghost" }),
          "size-8 rounded-md p-0 font-normal text-foreground aria-selected:opacity-100",
        ),
        today: "[&_button]:bg-muted [&_button]:text-foreground",
        selected:
          "[&_button]:bg-primary [&_button]:text-primary-foreground [&_button]:hover:bg-primary [&_button]:hover:text-primary-foreground",
        outside: "[&_button]:text-muted-foreground [&_button]:opacity-50",
        disabled: "[&_button]:text-muted-foreground [&_button]:opacity-30",
        hidden: "invisible",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, className: chevronClassName, ...chevronProps }) =>
          orientation === "left" ? (
            <ChevronLeftIcon className={cn("size-4", chevronClassName)} {...chevronProps} />
          ) : (
            <ChevronRightIcon className={cn("size-4", chevronClassName)} {...chevronProps} />
          ),
        DayButton: ({ className: dayButtonClassName, day: _day, modifiers: _modifiers, ...dayButtonProps }: DayButtonProps) => (
          <button type="button" className={dayButtonClassName} {...dayButtonProps} />
        ),
      }}
      {...props}
    />
  )
}

export { Calendar }
