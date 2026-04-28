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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { callAction } from "@/lib/errors/call-action";
import type { ContactRole } from "@/lib/messages/triage";

import {
  mergeUnknownSenderToPropertyAction,
  searchPropertiesForMatch,
  type PropertySearchHit,
} from "./actions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromAddress: string;
  latestBody: string;
};

/**
 * "Merge with existing property" dialog. Search by address, pick a
 * property, choose a role for the new contact (Homeowner / Agent),
 * confirm. The action creates a contact + the matching detail row,
 * sets the property's homeowner_contact_id or agent_contact_id, and
 * attaches every message from this from_address.
 */
export function MergePropertyDialog({
  open,
  onOpenChange,
  fromAddress,
  latestBody,
}: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PropertySearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [pendingMerge, startMergeTransition] = useTransition();
  const [selectedProperty, setSelectedProperty] =
    useState<PropertySearchHit | null>(null);
  const [role, setRole] = useState<ContactRole | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");

  // Debounced search.
  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(async () => {
      const result = await searchPropertiesForMatch(query);
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
      setSelectedProperty(null);
      setRole(null);
      setFirstName("");
      setLastName("");
    }
  }, [open]);

  const slotConflict =
    selectedProperty && role
      ? (role === "homeowner" && selectedProperty.homeownerContactId !== null) ||
        (role === "agent" && selectedProperty.agentContactId !== null)
      : false;

  const canMerge =
    selectedProperty !== null && role !== null && !slotConflict && !pendingMerge;

  const merge = () => {
    if (!canMerge || !selectedProperty || !role) return;
    startMergeTransition(async () => {
      const result = await callAction(
        mergeUnknownSenderToPropertyAction({
          fromAddress,
          propertyId: selectedProperty.id,
          role,
          contact: {
            firstName: firstName.trim() || null,
            lastName: lastName.trim() || null,
          },
        }),
        {
          successMessage: `Merged ${fromAddress} with ${selectedProperty.address}.`,
          fallbackMessage: "Merge failed",
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
          <DialogTitle>Merge with existing property</DialogTitle>
          <DialogDescription>
            Attach all messages from{" "}
            <span className="font-mono">{fromAddress}</span> to a property in
            Sandra. A new contact is created with this number as{" "}
            <code>phone_1</code> and linked to the property as either the
            homeowner or the agent.
          </DialogDescription>
        </DialogHeader>

        <div className="border-border bg-muted/40 rounded-md border p-3 text-xs">
          <div className="text-muted-foreground mb-1">Latest message:</div>
          <div className="line-clamp-3">{latestBody}</div>
        </div>

        {!selectedProperty ? (
          <>
            <div className="flex flex-col gap-2">
              <Label htmlFor="merge-prop-search">Search by address</Label>
              <Input
                id="merge-prop-search"
                placeholder="e.g. 203 E Woods, or just 'Woods'"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                autoFocus
                data-testid="merge-property-search-input"
              />
            </div>
            <div
              className="border-border max-h-72 overflow-auto rounded-md border"
              data-testid="merge-property-results"
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
                  No matching properties. Try a different query, or use "Create
                  new lead" instead.
                </div>
              )}
              {!searching &&
                hits.map((h) => (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => setSelectedProperty(h)}
                    data-testid={`merge-property-result-${h.id}`}
                    className="hover:bg-muted/70 flex w-full flex-col items-start gap-0.5 border-b border-border/40 p-2 text-left last:border-b-0"
                  >
                    <span className="text-sm font-medium">{h.address}</span>
                    <span className="text-muted-foreground text-[11px]">
                      {[h.city, h.state].filter(Boolean).join(", ") || "—"}
                      {h.homeownerContactId ? " · has homeowner" : ""}
                      {h.agentContactId ? " · has agent" : ""}
                    </span>
                  </button>
                ))}
            </div>
          </>
        ) : (
          <>
            <div className="border-border rounded-md border p-3 text-sm">
              <div className="text-muted-foreground mb-1 text-xs">
                Selected property:
              </div>
              <div className="font-medium">{selectedProperty.address}</div>
              <div className="text-muted-foreground text-xs">
                {[selectedProperty.city, selectedProperty.state]
                  .filter(Boolean)
                  .join(", ") || "—"}
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedProperty(null);
                  setRole(null);
                }}
                className="text-muted-foreground hover:text-foreground mt-1 text-xs underline"
              >
                Change
              </button>
            </div>

            <div className="flex flex-col gap-2">
              <Label>Role of the new contact on this property *</Label>
              <RadioGroup
                value={role ?? ""}
                onValueChange={(v) => setRole(v as ContactRole)}
                className="grid grid-cols-2 gap-3"
              >
                <label
                  className="border-input hover:bg-muted/50 has-[[data-checked]]:border-primary flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  data-testid="merge-property-role-homeowner"
                >
                  <RadioGroupItem value="homeowner" />
                  <span>Homeowner</span>
                </label>
                <label
                  className="border-input hover:bg-muted/50 has-[[data-checked]]:border-primary flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
                  data-testid="merge-property-role-agent"
                >
                  <RadioGroupItem value="agent" />
                  <span>Agent</span>
                </label>
              </RadioGroup>
              {slotConflict && (
                <div className="text-destructive text-xs">
                  Property already has a {role} contact. Pick a different role
                  or merge with the existing contact instead.
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1">
                <Label htmlFor="merge-first">First name</Label>
                <Input
                  id="merge-first"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  data-testid="merge-property-first"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="merge-last">Last name</Label>
                <Input
                  id="merge-last"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  data-testid="merge-property-last"
                />
              </div>
            </div>
          </>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pendingMerge}
          >
            Cancel
          </Button>
          {selectedProperty && (
            <Button
              onClick={merge}
              disabled={!canMerge}
              data-testid="merge-property-submit"
            >
              {pendingMerge ? "Merging…" : "Merge"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
