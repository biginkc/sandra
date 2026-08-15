"use client";

import { PlusIcon } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

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

import { createLeadFromForm } from "./new/actions";
import { SOURCE_LABELS, STATES } from "./new/form-options";
import type { TeamMember } from "./actions";

type AddLeadDialogProps = {
  markets: string[];
  sources: string[];
  teamMembers: TeamMember[];
  currentUserId: string | null;
  buttonClassName?: string;
};

export function AddLeadDialog({
  markets,
  sources,
  teamMembers,
  currentUserId,
  buttonClassName,
}: AddLeadDialogProps) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [open, setOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicatePropertyId, setDuplicatePropertyId] = useState<string | null>(
    null,
  );
  const [showContactWarning, setShowContactWarning] = useState(false);

  const resetDialog = () => {
    formRef.current?.reset();
    setDirty(false);
    setError(null);
    setDuplicatePropertyId(null);
    setShowContactWarning(false);
  };

  const requestClose = () => {
    if (savingRef.current) return;
    if (dirty && !window.confirm("Discard this unsaved lead?")) return;
    setOpen(false);
    resetDialog();
  };

  const submit = (formData: FormData, allowWithoutContact = false) => {
    if (savingRef.current) return;
    const phone = String(formData.get("phone_1") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    if (!allowWithoutContact && !phone && !email) {
      setShowContactWarning(true);
      return;
    }

    setShowContactWarning(false);
    setError(null);
    setDuplicatePropertyId(null);
    const input = {
      source: String(formData.get("source") ?? ""),
      address: String(formData.get("address") ?? "").trim(),
      city: String(formData.get("city") ?? "").trim(),
      state: String(formData.get("state") ?? "").trim(),
      zip: String(formData.get("zip") ?? "").trim(),
      market: String(formData.get("market") ?? "").trim(),
      first_name: String(formData.get("first_name") ?? "").trim(),
      last_name: String(formData.get("last_name") ?? "").trim(),
      phone_1: phone,
      email,
      assigned_user_id: String(formData.get("assigned_user_id") ?? "").trim(),
      motivation_level:
        (String(formData.get("motivation_level") ?? "").trim() as
          | "hot"
          | "warm"
          | "cold") || null,
    };

    savingRef.current = true;
    setIsSaving(true);
    void (async () => {
        let result: Awaited<ReturnType<typeof createLeadFromForm>>;
        try {
          result = await createLeadFromForm(input);
        } catch {
          setError("We couldn't create this lead. Try again.");
          return;
        }
        if (!result.ok) {
          setError(result.error.message);
          return;
        }
        if (result.data.wasDuplicate) {
          setDuplicatePropertyId(result.data.propertyId);
          return;
        }

        setDirty(false);
        setOpen(false);
        const warning = result.data.phoneDropped
          ? `?warning=${encodeURIComponent(
              `Phone ${result.data.phoneDropped} couldn't be classified (line-type lookup unavailable) — it's saved on the contact's notes, not as a callable number.`,
            )}`
          : "";
        router.push(`/leads/${result.data.propertyId}${warning}`);
      })().finally(() => {
        savingRef.current = false;
        setIsSaving(false);
      });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    submit(new FormData(event.currentTarget));
  };

  return (
    <>
      <Button className={buttonClassName} onClick={() => setOpen(true)}>
        <PlusIcon data-icon="inline-start" />
        Add lead
      </Button>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setOpen(true);
          else requestClose();
        }}
      >
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] grid-rows-none flex-col overflow-hidden sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add a lead</DialogTitle>
            <DialogDescription>
              Add the essentials now. You can complete the full record after it
              is created.
            </DialogDescription>
          </DialogHeader>

          <form
            ref={formRef}
            onSubmit={handleSubmit}
            onChange={() => {
              setDirty(true);
              setShowContactWarning(false);
              setDuplicatePropertyId(null);
            }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pr-1">
            <fieldset className="border-border flex flex-col gap-3 rounded-lg border p-4">
              <legend className="px-1 text-sm font-semibold">Source</legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="add-lead-source">How did this lead come in?</Label>
                  <select
                    id="add-lead-source"
                    name="source"
                    required
                    className="border-input bg-background flex h-10 w-full rounded-md border px-3 py-2 text-sm"
                    defaultValue="cold_call"
                  >
                    {sources.map((source) => (
                      <option key={source} value={source}>
                        {SOURCE_LABELS[source] ?? source}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="add-lead-assignee">Assigned teammate</Label>
                  <select
                    id="add-lead-assignee"
                    name="assigned_user_id"
                    className="border-input bg-background flex h-10 w-full rounded-md border px-3 py-2 text-sm"
                    defaultValue={currentUserId ?? ""}
                  >
                    {currentUserId ? <option value={currentUserId}>You</option> : null}
                    {teamMembers
                      .filter((member) => member.id !== currentUserId)
                      .map((member) => (
                        <option key={member.id} value={member.id}>
                          {member.email}
                        </option>
                      ))}
                    <option value="">Unassigned</option>
                  </select>
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-lead-motivation">Motivation (optional)</Label>
                <select
                  id="add-lead-motivation"
                  name="motivation_level"
                  className="border-input bg-background flex h-10 w-full rounded-md border px-3 py-2 text-sm"
                  defaultValue=""
                >
                  <option value="">Not set</option>
                  <option value="hot">Hot</option>
                  <option value="warm">Warm</option>
                  <option value="cold">Cold</option>
                </select>
              </div>
            </fieldset>

            <fieldset className="border-border flex flex-col gap-3 rounded-lg border p-4">
              <legend className="px-1 text-sm font-semibold">Property</legend>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="add-lead-address">Street address</Label>
                <Input
                  id="add-lead-address"
                  name="address"
                  required
                  placeholder="123 Main St"
                  autoComplete="street-address"
                />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1.5 sm:col-span-2">
                  <Label htmlFor="add-lead-city">City</Label>
                  <Input
                    id="add-lead-city"
                    name="city"
                    placeholder="Kansas City"
                    autoComplete="address-level2"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="add-lead-state">State</Label>
                  <select
                    id="add-lead-state"
                    name="state"
                    required
                    className="border-input bg-background flex h-10 w-full rounded-md border px-3 py-2 text-sm"
                    defaultValue="MO"
                    autoComplete="address-level1"
                  >
                    {STATES.map((state) => (
                      <option key={state} value={state}>
                        {state}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="add-lead-zip">ZIP</Label>
                  <Input
                    id="add-lead-zip"
                    name="zip"
                    placeholder="64111"
                    inputMode="numeric"
                    autoComplete="postal-code"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="add-lead-market">Market</Label>
                  <select
                    id="add-lead-market"
                    name="market"
                    className="border-input bg-background flex h-10 w-full rounded-md border px-3 py-2 text-sm"
                    defaultValue=""
                  >
                    <option value="">— pick a market —</option>
                    {markets.map((market) => (
                      <option key={market} value={market}>
                        {market}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </fieldset>

            <fieldset className="border-border flex flex-col gap-3 rounded-lg border p-4">
              <legend className="px-1 text-sm font-semibold">
                Homeowner contact
              </legend>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="add-lead-first-name">First name</Label>
                  <Input
                    id="add-lead-first-name"
                    name="first_name"
                    autoComplete="given-name"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="add-lead-last-name">Last name</Label>
                  <Input
                    id="add-lead-last-name"
                    name="last_name"
                    autoComplete="family-name"
                  />
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="add-lead-phone">Phone</Label>
                  <Input
                    id="add-lead-phone"
                    name="phone_1"
                    type="tel"
                    placeholder="+18165551234"
                    inputMode="tel"
                    autoComplete="tel"
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="add-lead-email">Email</Label>
                  <Input
                    id="add-lead-email"
                    name="email"
                    type="email"
                    placeholder="owner@example.com"
                    autoComplete="email"
                  />
                </div>
              </div>
            </fieldset>

            {showContactWarning ? (
              <div
                className="border-amber-300 bg-amber-50 text-amber-950 rounded-lg border p-3 text-sm"
                role="alert"
              >
                <p className="font-semibold">No phone or email was provided.</p>
                <p className="mt-1 text-xs">
                  You can still create this lead, but the team will not have a
                  contact method yet.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  disabled={isSaving}
                  onClick={() => {
                    if (formRef.current) {
                      submit(new FormData(formRef.current), true);
                    }
                  }}
                >
                  Create without contact details
                </Button>
              </div>
            ) : null}

            {error ? (
              <div
                className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border p-3 text-sm"
                role="alert"
                aria-live="polite"
              >
                {error}
              </div>
            ) : null}

            {duplicatePropertyId ? (
              <div
                className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"
                role="alert"
                aria-live="polite"
              >
                <p className="font-semibold">
                  A lead already exists at this address.
                </p>
                <p className="mt-1 text-xs">
                  Nothing new was created. Open the existing record to review it.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => {
                    setDirty(false);
                    setOpen(false);
                    router.push(`/leads/${duplicatePropertyId}`);
                  }}
                >
                  Open existing lead
                </Button>
              </div>
            ) : null}
            </div>

            <DialogFooter className="bg-background mx-0 mb-0 shrink-0 rounded-lg pt-3">
              <Button
                type="button"
                variant="outline"
                onClick={requestClose}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? "Creating…" : "Create lead"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
