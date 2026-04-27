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
import { callAction } from "@/lib/errors/call-action";

import { createContactFromUnknownAction } from "./actions";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromAddress: string;
};

/**
 * "Create new contact + property from unknown sender" dialog. Minimal
 * fields — name + property address. The from_address is locked in as
 * phone_1. On success, navigates to the newly-created lead.
 */
export function CreateContactDialog({
  open,
  onOpenChange,
  fromAddress,
}: Props) {
  const router = useRouter();
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("MO");
  const [zip, setZip] = useState("");
  const [pending, startTransition] = useTransition();

  const canSubmit =
    address.trim().length > 0 && state.trim().length === 2 && !pending;

  const submit = () => {
    if (!canSubmit) return;
    startTransition(async () => {
      const result = await callAction(
        createContactFromUnknownAction({
          fromAddress,
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
          successMessage: "Contact + property created.",
          fallbackMessage: "Could not create",
        },
      );
      if (result.ok) {
        onOpenChange(false);
        // Reset form for next time the dialog opens.
        setFirstName("");
        setLastName("");
        setAddress("");
        setCity("");
        setZip("");
        // Navigate to the new lead so the VA can start working it.
        router.push(`/leads/${result.data.propertyId}`);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create new contact + property</DialogTitle>
          <DialogDescription>
            Phone <span className="font-mono">{fromAddress}</span> will be saved
            as the contact's <code>phone_1</code>. All inbound messages from
            this number get attached automatically.
          </DialogDescription>
        </DialogHeader>

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
            {pending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
