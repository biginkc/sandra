import { useState } from "react"
import { ArrowRight, MessageSquare, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import type { MyLeadDetailPanelProps, MyLeadSmsMessage } from "./types"

type MyLeadSmsStripProps = Pick<MyLeadDetailPanelProps, "state" | "onRetry" | "onLoadDetailPage">

export function MyLeadSmsStrip({ state, onRetry, onLoadDetailPage }: MyLeadSmsStripProps) {
  const [paging, setPaging] = useState<{
    loading: "earlier" | "refresh" | null
    error: { message: string; cursor: string | null } | null
  }>({ loading: null, error: null })

  if (state.status === "loading") {
    return <div className="pt-3 text-xs text-muted-foreground" role="status">Loading texts…</div>
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-wrap items-center gap-2 pt-3 text-xs text-destructive" role="alert">
        <span>Text history unavailable. {state.message}</span>
        <Button type="button" variant="outline" size="xs" onClick={onRetry}>Retry text history</Button>
      </div>
    )
  }

  const page = state.detail.messages
  // The shared detail cache appends older pages in descending order. Reverse
  // the complete loaded group, so earlier pages appear before the recent texts.
  const messages = [...page.rows].reverse()
  const loadMessages = async (cursor: string | null) => {
    if (paging.loading) return
    if (!onLoadDetailPage) {
      if (cursor === null) onRetry()
      return
    }
    setPaging({ loading: cursor === null ? "refresh" : "earlier", error: null })
    try {
      const result = await onLoadDetailPage("messages", cursor)
      const error = result.ok
        ? result.group === "messages" ? null : "The text history page was unavailable."
        : result.message
      setPaging({
        loading: null,
        error: error ? { message: error, cursor } : null,
      })
    } catch {
      setPaging({
        loading: null,
        error: { message: cursor === null ? "Unable to refresh texts." : "Unable to load earlier texts.", cursor },
      })
    }
  }

  return (
    <section className="min-w-0 space-y-2 pt-3" aria-label="Text history">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
        <h3 className="inline-flex items-center gap-1.5 font-extrabold tracking-[0.08em] uppercase">
          <MessageSquare className="size-3" aria-hidden="true" />
          Texts
        </h3>
        {messages.length > 0 && (
          <span>{page.hasMore ? "Latest " : ""}{messages.length} {messages.length === 1 ? "text" : "texts"} · oldest to newest</span>
        )}
      </div>

      {messages.length === 0 ? (
        <p className="text-xs text-muted-foreground">No texts yet.</p>
      ) : (
        <ol className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-2" aria-label="Text message history">
          {messages.map((message, index) => (
            <li key={message.id} className="flex min-w-0 max-w-full items-center gap-2">
              {index > 0 && <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
              <SmsMessageChip message={message} />
            </li>
          ))}
        </ol>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {page.hasMore && page.nextCursor && onLoadDetailPage && (
          <Button type="button" variant="link" size="xs" className="h-auto px-0 py-1 text-[11px]" disabled={Boolean(paging.loading)} onClick={() => loadMessages(page.nextCursor)}>
            {paging.loading === "earlier" ? "Loading earlier texts…" : "Load earlier texts"}
          </Button>
        )}
        <Button type="button" variant="link" size="xs" className="h-auto px-0 py-1 text-[11px]" disabled={Boolean(paging.loading)} onClick={() => loadMessages(null)}>
          <RefreshCw className="size-3" aria-hidden="true" />
          {paging.loading === "refresh" ? "Refreshing texts…" : "Refresh texts"}
        </Button>
      </div>
      {paging.error && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-destructive" role="alert">
          <span>{paging.error.message}</span>
          <Button type="button" variant="outline" size="xs" disabled={Boolean(paging.loading)} onClick={() => loadMessages(paging.error!.cursor)}>
            <RefreshCw className="size-3" aria-hidden="true" />
            {paging.error.cursor === null ? "Retry refresh" : "Retry earlier texts"}
          </Button>
        </div>
      )}
    </section>
  )
}

function SmsMessageChip({ message }: { message: MyLeadSmsMessage }) {
  const sender = message.direction === "outbound" ? "Us" : "Them"
  const notDelivered = message.direction === "outbound" && ["failed", "bounced"].includes(message.deliveryStatus)
  const excerpt = messageExcerpt(message)

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "inline-flex min-w-0 max-w-[20rem] items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] leading-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
          message.direction === "outbound"
            ? "border-blue-200 bg-blue-50 text-blue-900 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200 dark:hover:bg-blue-950"
            : "border-stone-200 bg-stone-50 text-stone-800 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:bg-stone-800"
        )}
        aria-label={`${sender}: ${excerpt}${notDelivered ? " · Not delivered" : ""}. Open full text`}
      >
        <span className="shrink-0 font-bold">{sender}:</span>
        <span className="min-w-0 truncate">{excerpt}</span>
        {notDelivered && <span className="shrink-0 text-[10px] font-semibold text-destructive">Not delivered</span>}
      </PopoverTrigger>
      <PopoverContent align="start" className="max-h-[min(70dvh,28rem)] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto p-3 [overflow-wrap:anywhere]">
        <div className="space-y-1">
          <PopoverTitle className="text-sm font-semibold">Text from {sender.toLowerCase()}</PopoverTitle>
          <p className="text-xs text-muted-foreground"><time dateTime={message.createdAt}>{message.createdLabel}</time></p>
          {notDelivered && <p className="text-xs font-semibold text-destructive">Not delivered</p>}
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
          {message.body.trim() ? message.body : message.attachmentCount > 0 ? "Attachment-only message" : "No text content"}
        </p>
        {message.attachmentCount > 0 && (
          <p className="text-xs text-muted-foreground">{attachmentLabel(message.attachmentCount)}</p>
        )}
      </PopoverContent>
    </Popover>
  )
}

function messageExcerpt(message: MyLeadSmsMessage) {
  const text = message.body.replace(/\s+/g, " ").trim()
  if (!text) return message.attachmentCount > 0 ? attachmentLabel(message.attachmentCount) : "No text content"
  const characters = Array.from(text)
  return characters.length > 64 ? `${characters.slice(0, 63).join("").trimEnd()}…` : text
}

function attachmentLabel(count: number) {
  return `${count} ${count === 1 ? "attachment" : "attachments"}`
}
