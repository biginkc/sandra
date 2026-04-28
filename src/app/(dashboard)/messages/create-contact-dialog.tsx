"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

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

import { createContactFromUnknownAction } from "./actions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromAddress: string;
};

/**
 * "Create new lead" dialog — promote an unknown sender to a brand-new
 * contact + property. The from_address goes in as phone_1; the role
 * (homeowner / agent) decides which detail-table row gets created and
 * which FK on the property gets set. On success, navigates to the new
 * lead.
 */
export function CreateContactDialog({
  open,
  onOpenChange,
  fromAddress,
}: Props) {
  const router = useRouter();
  const [role, setRole] = useState<ContactRole | null>(null);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("MO");
  const [zip, setZip] = useState("");
  const [pending, startTransition] = useTransition();

  const canSubmit =
    role !== null &&
    address.trim().length > 0 &&
    state.trim().length === 2 &&
    !pending;

  const submit = () => {
    if (!canSubmit || !role) return;
    startTransition(async () => {
      const result = await callAction(
        createContactFromUnknownAction({
          fromAddress,
          role,
          contact: {
            firstName: firstName.trim() || null,
            lastName: lastName.trim() || null,
          },
          property: {
            address: address.trim(),
            city: city.trim() || null,
            state: state.trim().toUpperCase(),
            zip: zip.trim() || null,
          },
        }),
        {
          successMessage: "Lead created.",
          fallbackMessage: "Could not create",
        },
      );
      if (result.ok) {
        onOpenChange(false);
        setRole(null);
        setFirstName("");
        setLastName("");
        setAddress("");
        setCity("");
        setZip("");
        router.push(`/leads/${result.data.propertyId}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create new lead</DialogTitle>
          <DialogDescription>
            Phone <span className="font-mono">{fromAddress}</span> will be saved
            as the contact's <code>phone_1</code>. All inbound messages from
            this number get attached to the new lead automatically.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2">
          <Label>Contact role on this property *</Label>
          <RadioGroup
            value={role ?? ""}
            onValueChange={(v) => setRole(v as ContactRole)}
            className="grid grid-cols-2 gap-3"
          >
            <label
              className="border-input hover:bg-muted/50 has-[[data-checked]]:border-primary flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
              data-testid="role-homeowner"
            >
              <RadioGroupItem value="homeowner" />
              <span>Homeowner</span>
            </label>
            <label
              className="border-input hover:bg-muted/50 has-[[data-checked]]:border-primary flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm"
              data-testid="role-agent"
            >
              <RadioGroupItem value="agent" />
              <span>Agent</span>
            </label>
          </RadioGroup>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="cc-first">First name</Label>
            <Input
              id="cc-first"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              data-testid="create-first"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cc-last">Last name</Label>
            <Input
              id="cc-last"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              data-testid="create-last"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="cc-address">Property address *</Label>
          <Input
            id="cc-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St"
            data-testid="create-address"
          />
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 flex flex-col gap-1">
            <Label htmlFor="cc-city">City</Label>
            <Input
              id="cc-city"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              data-testid="create-city"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="cc-state">State *</Label>
            <Input
              id="cc-state"
              value={state}
              onChange={(e) => setState(e.target.value)}
              maxLength={2}
              data-testid="create-state"
            />
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="cc-zip">Zip</Label>
          <Input
            id="cc-zip"
            value={zip}
            onChange={(e) => setZip(e.target.value)}
            data-testid="create-zip"
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!canSubmit}
            data-testid="create-submit"
          >
            {pending ? "Creating…" : "Create lead"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
