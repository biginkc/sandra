"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
  createPropertyAndResolveAction,
  listResolveCandidatesAction,
  resolveThreadToPropertyAction,
  searchPropertiesForMatch,
  type PropertySearchHit,
  type ResolveCandidateProperty,
} from "./actions";

type PropertyChoice = {
  id: string;
  address: string;
  city: string | null;
  state: string | null;
  homeownerContactId: string | null;
  agentContactId: string | null;
  outreachDispo?: string | null;
  needsHumanAttention?: boolean;
  isCandidate: boolean;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceConversationId: string;
  contactId: string;
};

export function ResolveToPropertyDialog({
  open,
  onOpenChange,
  sourceConversationId,
  contactId,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [candidates, setCandidates] = useState<ResolveCandidateProperty[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<PropertySearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [selectedProperty, setSelectedProperty] =
    useState<PropertyChoice | null>(null);
  const [role, setRole] = useState<ContactRole | null>(null);
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("MO");
  const [zip, setZip] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const result = await listResolveCandidatesAction({
        sourceConversationId,
        contactId,
      });
      if (!cancelled && result.ok) setCandidates(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, sourceConversationId, contactId]);

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

  useEffect(() => {
    if (open) return;
    setCandidates([]);
    setQuery("");
    setHits([]);
    setSelectedProperty(null);
    setRole(null);
    setMode("existing");
    setAddress("");
    setCity("");
    setState("MO");
    setZip("");
  }, [open]);

  const slotConflict =
    selectedProperty && role
      ? (role === "homeowner" &&
          selectedProperty.homeownerContactId !== null &&
          selectedProperty.homeownerContactId !== contactId) ||
        (role === "agent" &&
          selectedProperty.agentContactId !== null &&
          selectedProperty.agentContactId !== contactId)
      : false;
  const canResolve = selectedProperty !== null && !slotConflict && !pending;
  const canCreate =
    role !== null &&
    address.trim().length > 0 &&
    state.trim().length === 2 &&
    !pending;

  function replaceThread(conversationId: string) {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("thread", conversationId);
    router.replace(`/messages?${sp.toString()}`);
    router.refresh();
  }

  function resolveSelected() {
    if (!canResolve || !selectedProperty) return;
    startTransition(async () => {
      const result = await callAction(
        resolveThreadToPropertyAction({
          sourceConversationId,
          contactId,
          propertyId: selectedProperty.id,
          role,
        }),
        {
          successMessage: "Conversation resolved.",
          fallbackMessage: "Resolve failed",
        },
      );
      if (result.ok) {
        onOpenChange(false);
        replaceThread(result.data.conversationId);
      }
    });
  }

  function createAndResolve() {
    if (!canCreate || !role) return;
    startTransition(async () => {
      const result = await callAction(
        createPropertyAndResolveAction({
          sourceConversationId,
          contactId,
          role,
          property: {
            address: address.trim(),
            city: city.trim() || null,
            state: state.trim().toUpperCase(),
            zip: zip.trim() || null,
          },
        }),
        {
          successMessage: "Lead created.",
          fallbackMessage: "Create failed",
        },
      );
      if (result.ok) {
        onOpenChange(false);
        replaceThread(result.data.conversationId);
      }
    });
  }

  const candidateChoices = candidates.map(candidateToChoice);
  const searchChoices = hits.map(searchHitToChoice);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Resolve to property</DialogTitle>
        </DialogHeader>

        <div className="flex gap-2">
          <Button
            type="button"
            variant={mode === "existing" ? "default" : "outline"}
            onClick={() => setMode("existing")}
            data-testid="resolve-mode-existing"
          >
            Existing property
          </Button>
          <Button
            type="button"
            variant={mode === "create" ? "default" : "outline"}
            onClick={() => {
              setMode("create");
              setSelectedProperty(null);
            }}
            data-testid="resolve-mode-create"
          >
            Create new property
          </Button>
        </div>

        {mode === "existing" ? (
          <>
            {selectedProperty ? (
              <SelectedProperty
                property={selectedProperty}
                onClear={() => {
                  setSelectedProperty(null);
                  setRole(null);
                }}
              />
            ) : (
              <>
                <PropertyList
                  title="Suggested"
                  emptyText="No suggestions for this contact."
                  properties={candidateChoices}
                  onSelect={setSelectedProperty}
                  testId="resolve-candidates"
                />

                <div className="flex flex-col gap-2">
                  <Label htmlFor="resolve-property-search">Search properties</Label>
                  <Input
                    id="resolve-property-search"
                    placeholder="Search by address or city"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    data-testid="resolve-property-search-input"
                  />
                </div>
                <div
                  className="border-border max-h-56 overflow-auto rounded-md border"
                  data-testid="resolve-property-results"
                >
                  {searching ? (
                    <div className="text-muted-foreground p-3 text-center text-xs">
                      Searching...
                    </div>
                  ) : null}
                  {!searching && query.trim().length < 2 ? (
                    <div className="text-muted-foreground p-3 text-center text-xs">
                      Type at least 2 characters to search.
                    </div>
                  ) : null}
                  {!searching &&
                  query.trim().length >= 2 &&
                  searchChoices.length === 0 ? (
                    <div className="text-muted-foreground p-3 text-center text-xs">
                      No matching properties.
                    </div>
                  ) : null}
                  {!searching
                    ? searchChoices.map((property) => (
                        <PropertyButton
                          key={property.id}
                          property={property}
                          onSelect={setSelectedProperty}
                        />
                      ))
                    : null}
                </div>
              </>
            )}

            {selectedProperty ? (
              <RolePicker
                role={role}
                setRole={setRole}
                slotConflict={slotConflict}
              />
            ) : null}
          </>
        ) : (
          <>
            <RolePicker
              role={role}
              setRole={setRole}
              slotConflict={false}
              requireRole
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1 sm:col-span-2">
                <Label htmlFor="resolve-create-address">Property address *</Label>
                <Input
                  id="resolve-create-address"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  data-testid="resolve-create-address"
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor="resolve-create-city">City</Label>
                <Input
                  id="resolve-create-city"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  data-testid="resolve-create-city"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="resolve-create-state">State *</Label>
                  <Input
                    id="resolve-create-state"
                    value={state}
                    onChange={(e) => setState(e.target.value)}
                    maxLength={2}
                    data-testid="resolve-create-state"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="resolve-create-zip">Zip</Label>
                  <Input
                    id="resolve-create-zip"
                    value={zip}
                    onChange={(e) => setZip(e.target.value)}
                    data-testid="resolve-create-zip"
                  />
                </div>
              </div>
            </div>
          </>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          {mode === "existing" ? (
            <Button
              onClick={resolveSelected}
              disabled={!canResolve}
              data-testid="resolve-property-submit"
            >
              {pending ? "Resolving..." : "Resolve"}
            </Button>
          ) : (
            <Button
              onClick={createAndResolve}
              disabled={!canCreate}
              data-testid="resolve-create-submit"
            >
              {pending ? "Creating..." : "Create and resolve"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PropertyList({
  title,
  emptyText,
  properties,
  onSelect,
  testId,
}: {
  title: string;
  emptyText: string;
  properties: PropertyChoice[];
  onSelect: (property: PropertyChoice) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{title}</Label>
      <div
        className="border-border max-h-48 overflow-auto rounded-md border"
        data-testid={testId}
      >
        {properties.length === 0 ? (
          <div className="text-muted-foreground p-3 text-center text-xs">
            {emptyText}
          </div>
        ) : (
          properties.map((property) => (
            <PropertyButton
              key={property.id}
              property={property}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}

function PropertyButton({
  property,
  onSelect,
}: {
  property: PropertyChoice;
  onSelect: (property: PropertyChoice) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(property)}
      data-testid={`resolve-property-result-${property.id}`}
      className="hover:bg-muted/70 flex w-full flex-col items-start gap-1 border-b border-border/40 p-2 text-left last:border-b-0"
    >
      <span className="text-sm font-medium">{property.address}</span>
      <span className="text-muted-foreground text-[11px]">
        {[property.city, property.state].filter(Boolean).join(", ") || "-"}
        {property.homeownerContactId ? " - has homeowner" : ""}
        {property.agentContactId ? " - has agent" : ""}
      </span>
      {property.isCandidate ? (
        <span className="flex flex-wrap gap-1">
          {property.outreachDispo ? (
            <Badge variant="secondary" className="text-[10px]">
              {property.outreachDispo}
            </Badge>
          ) : null}
          {property.needsHumanAttention ? (
            <Badge variant="destructive" className="text-[10px]">
              Escalated
            </Badge>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

function SelectedProperty({
  property,
  onClear,
}: {
  property: PropertyChoice;
  onClear: () => void;
}) {
  return (
    <div className="border-border rounded-md border p-3 text-sm">
      <div className="text-muted-foreground mb-1 text-xs">Selected property</div>
      <div className="font-medium">{property.address}</div>
      <div className="text-muted-foreground text-xs">
        {[property.city, property.state].filter(Boolean).join(", ") || "-"}
      </div>
      <button
        type="button"
        onClick={onClear}
        className="text-muted-foreground hover:text-foreground mt-1 text-xs underline"
      >
        Change
      </button>
    </div>
  );
}

function RolePicker({
  role,
  setRole,
  slotConflict,
  requireRole = false,
}: {
  role: ContactRole | null;
  setRole: (role: ContactRole | null) => void;
  slotConflict: boolean;
  requireRole?: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Contact role{requireRole ? " *" : ""}</Label>
      <RadioGroup
        value={role ?? "none"}
        onValueChange={(v) => setRole(v === "none" ? null : (v as ContactRole))}
        className="grid grid-cols-3 gap-3"
      >
        {!requireRole ? (
          <label
            className="border-input hover:bg-muted/50 has-[[data-checked]]:border-primary flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
            data-testid="resolve-role-none"
          >
            <RadioGroupItem value="none" />
            <span>No role</span>
          </label>
        ) : null}
        <label
          className="border-input hover:bg-muted/50 has-[[data-checked]]:border-primary flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
          data-testid="resolve-role-homeowner"
        >
          <RadioGroupItem value="homeowner" />
          <span>Homeowner</span>
        </label>
        <label
          className="border-input hover:bg-muted/50 has-[[data-checked]]:border-primary flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
          data-testid="resolve-role-agent"
        >
          <RadioGroupItem value="agent" />
          <span>Agent</span>
        </label>
      </RadioGroup>
      {slotConflict ? (
        <div className="text-destructive text-xs">
          That role is already held by another contact.
        </div>
      ) : null}
    </div>
  );
}

function candidateToChoice(candidate: ResolveCandidateProperty): PropertyChoice {
  return {
    id: candidate.id,
    address: candidate.address,
    city: candidate.city,
    state: candidate.state,
    homeownerContactId: candidate.homeownerContactId,
    agentContactId: candidate.agentContactId,
    outreachDispo: candidate.outreachDispo,
    needsHumanAttention: candidate.needsHumanAttention,
    isCandidate: true,
  };
}

function searchHitToChoice(hit: PropertySearchHit): PropertyChoice {
  return {
    id: hit.id,
    address: hit.address,
    city: hit.city,
    state: hit.state,
    homeownerContactId: hit.homeownerContactId,
    agentContactId: hit.agentContactId,
    isCandidate: false,
  };
}
