"use client"

import { Button } from "@/components/ui/button"
import { clearAllSubmissions } from "@/app/(dashboard)/my-leads/_components/submission-store"

/** Sign out, and forget any My Leads save records this browser session held. */
export function SignOutForm() {
  return (
    <form action="/auth/signout" method="post" className="border-l border-white/10" onSubmit={() => clearAllSubmissions()}>
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        className="h-auto rounded-lg px-[14px] py-[7px] pl-4 text-sm font-semibold text-white hover:bg-white/[0.07] hover:text-white"
      >
        Sign out
      </Button>
    </form>
  )
}
