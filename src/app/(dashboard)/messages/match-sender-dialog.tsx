"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { callAction } from "@/lib/errors/call-action";

import {
  matchUnknownSenderAction,
  searchContactsForMatch,
  type ContactSearchHit,
} from "./actions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromAddress: string;
  latestBody: string;
};

/**
 * "Match to existing lead" dialog. Search contacts, pick one, the
 * matchUnknownSender action attaches every message from this from_address
 * AND adds the from_address to the contact's phone_2/3 if absent.
 */
export function MatchSenderDialog({
  open,
  onOpenChange,
  fromAddress,
  latestBody,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ContactSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pending, startTransition] = useTransition();

  // Debounce search.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const result = await searchContactsForMatch(query);
      if (cancelled) return;
      if (result.ok) setHits(result.data);
      setSearching(false);
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
      setSearching(false);
    };
  }, [query, open]);

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setHits([]);
    }
  }, [open]);

  const match = (contactId: string, displayName: string) => {
    startTransition(async () => {
      const result = await callAction(
        matchUnknownSenderAction(fromAddress, contactId),
        {
          successMessage: `Matched ${fromAddress} to ${displayName}.`,
          fallbackMessage: "Match failed",
        },
      );
      if (result.ok) {
        onOpenChange(false);
        router.refresh();
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge with existing contact</DialogTitle>
          <DialogDescription>
            Attach all messages from{" "}
            <span className="font-mono">{fromAddress}</span> to a contact in
            Sandra. The number is added to <code>phone_2</code> (or{" "}
            <code>phone_3</code>) so future inbounds from this sender match
            automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="border-border bg-muted/40 rounded-md border p-3 text-xs">
          <div className="text-muted-foreground mb-1">Latest message:</div>
          <div className="line-clamp-3">{latestBody}</div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="match-search">Search by name or phone</Label>
          <Input
            id="match-search"
            placeholder="e.g. Booth, or 816"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
            data-testid="match-search-input"
          />
        </div>

        <div
          className="border-border max-h-72 overflow-auto rounded-md border"
          data-testid="match-results"
        >
          {searching && (
            <div className="text-muted-foreground p-3 text-center text-xs">
              Searching…
            </div>
          )}
          {!searching && query.trim().length < 2 && (
            <div className="text-muted-foreground p-3 text-center text-xs">
              Type at least 2 characters to search.
            </div>
          )}
          {!searching && query.trim().length >= 2 && hits.length === 0 && (
            <div className="text-muted-foreground p-3 text-center text-xs">
              No matches. Try a different query, or use "Create new contact" instead.
            </div>
          )}
          {!searching &&
            hits.map((h) => (
              <button
                key={h.id}
                type="button"
                disabled={pending}
                onClick={() => match(h.id, h.displayName)}
                data-testid={`match-result-${h.id}`}
                className="hover:bg-muted/70 flex w-full flex-col items-start gap-0.5 border-b border-border/40 p-2 text-left last:border-b-0 disabled:opacity-50"
              >
                <span className="text-sm font-medium">{h.displayName}</span>
                <span className="text-muted-foreground text-[11px]">
                  {h.phone1 ?? "no phone_1"}
                  {h.propertyAddress ? ` · ${h.propertyAddress}` : ""}
                </span>
              </button>
            ))}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
