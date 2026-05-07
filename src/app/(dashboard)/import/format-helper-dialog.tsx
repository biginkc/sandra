"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { copyToClipboard } from "@/lib/csv/export";
import type { VendorPresetId } from "@/lib/csv/presets/types";

/** Fixed copy + signature headers per vendor — kept here, not on the
 *  preset modules, so the dialog has full control over user-facing
 *  language without touching detection / transform logic. */
type VendorEntry = {
  id: VendorPresetId;
  label: string;
  description: string;
  /** What we'll auto-clean if detected — bullet list. */
  autoFixes: string[];
  /** Headers we look for to recognize this vendor — copy-able for users
   *  who want to align an unfamiliar export by hand. */
  signatureHeaders: string[];
  /** Importable vs not-a-lead-source. */
  importable: boolean;
};

const VENDORS: VendorEntry[] = [
  {
    id: "propstream",
    label: "PropStream Property Export",
    description:
      'PropStream\'s per-county property exports — "Tired Landlords", "Vacant", "Seniors", "Low Equity", and similar list types.',
    autoFixes: [
      "Collapse the 5-phone block down to 3 homeowner phone slots; DNC entries dropped first",
      "Decode any DNC flag into the homeowner Do-Not-Contact field",
      "Map Owner 1's name into homeowner first/last; Owner 2 dropped (multi-owner deferred)",
    ],
    signatureHeaders: ["Phone 1", "Phone 1 Type", "Phone 1 DNC", "Method of Add"],
    importable: true,
  },
  {
    id: "titlepro",
    label: "TitlePro / DataTree Title Events",
    description:
      "Title-event exports — Death (AD), Cash Purchase (CP), Lis Pendens (LP), Bankruptcy (BK), Default/Foreclosure (DF). Detected by the two-letter event prefix on event columns.",
    autoFixes: [
      'Merge dual APN columns (numeric + Excel-armored ="...") into one',
      "Collapse repeated parcel rows that share the same event date",
      "Tag the event subtype on the import (Death, Lis Pendens, etc.)",
    ],
    signatureHeaders: ["APN", "APN (text)", "1st Owner's First Name", "1st Owner's Last Name", "AD.type | CP.type | LP.type | BK.type | DF.type", "AD.file_date | CP.file_date | LP.file_date | BK.file_date | DF.file_date"],
    importable: true,
  },
  {
    id: "reisift",
    label: "REISift / DealMachine Skipped Contacts",
    description:
      'Contact-centric skip-trace exports (often labeled "dealmachine-contacts-*.csv" or similar). One row per person, snake_case headers, three phones with carrier metadata.',
    autoFixes: [
      'Decode the literal "DNC Excluded" sentinel into proper Do-Not-Contact flags',
      "Reconcile the combined-address vs split-address columns (whichever is complete wins)",
      "Fold the 3-phone block into homeowner phone slots (carrier/usage metadata dropped)",
    ],
    signatureHeaders: ["contact_id", "associated_property_id", "phone_1"],
    importable: true,
  },
  {
    id: "bmh_outreach",
    label: "BMH Agent Outreach Sheets",
    description:
      "BMH's per-county agent-outreach Sheets (Clay County MO, Camden County MO, Caddo Parish LA, etc.). Each row is an agent contact tied to a property listing.",
    autoFixes: [
      "Split the combined Property Address into address / city / state / zip",
      "Map First Name / Last Name / Phone / Email to agent contact fields",
      "Carry Status / Follow Up / Lead Source through as tags on the import",
    ],
    signatureHeaders: [
      "Property Address",
      "First Name",
      "Last Name",
      "Phone",
      "Email",
      "Link",
      "Status",
      "Follow Up",
      "Lead Source",
      "Date Created",
      "County",
    ],
    importable: true,
  },
  {
    id: "permits",
    label: "Municipal Permits",
    description:
      "Permit-status exports from city open-data portals. These don't carry an address or owner name — they're property enrichment data, not a lead source.",
    autoFixes: [],
    signatureHeaders: ["PermitNum", "AppliedDate", "IssuedDate", "StatusCurrent"],
    importable: false,
  },
  {
    id: "cnam",
    label: "CNAM Lookup Tables",
    description:
      "Phone → caller-name lookup tables (`cnam_update.csv`). Useful for phone enrichment, not for importing leads.",
    autoFixes: [],
    signatureHeaders: ["phones", "cnam"],
    importable: false,
  },
];

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional preset to scroll to — set this when the banner's
   *  "What does this do?" link opens the dialog. */
  scrollToPresetId?: VendorPresetId | null;
};

export function FormatHelperDialog({ open, onOpenChange, scrollToPresetId }: Props) {
  const [copyingHeaders, setCopyingHeaders] = useState<VendorPresetId | null>(null);

  const handleCopyHeaders = async (vendor: VendorEntry) => {
    setCopyingHeaders(vendor.id);
    const ok = await copyToClipboard(vendor.signatureHeaders.join(","));
    setCopyingHeaders(null);
    if (ok) {
      toast.success(`${vendor.label} headers copied to clipboard.`);
    } else {
      toast.error("Couldn't copy. Select the headers and copy manually.");
    }
  };

  const importable = VENDORS.filter((v) => v.importable);
  const nonImportable = VENDORS.filter((v) => !v.importable);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Need help with your input file?</DialogTitle>
          <DialogDescription>
            Drop in any of these vendor exports as-is — we&apos;ll auto-detect
            the format, set the lead source, and clean the file before
            mapping. No manual editing.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-6 py-2">
          {importable.map((vendor) => (
            <section
              key={vendor.id}
              id={`format-helper-${vendor.id}`}
              className={
                scrollToPresetId === vendor.id
                  ? "rounded-md border border-emerald-300 bg-emerald-50/50 p-4 dark:border-emerald-700 dark:bg-emerald-950/30"
                  : "rounded-md border p-4"
              }
            >
              <h3 className="text-sm font-semibold">{vendor.label}</h3>
              <p className="text-muted-foreground mt-1 text-xs">
                {vendor.description}
              </p>

              <div className="mt-3 text-xs">
                <span className="font-medium">What we&apos;ll fix automatically:</span>
                <ul className="text-muted-foreground mt-1 list-disc pl-5">
                  {vendor.autoFixes.map((fix) => (
                    <li key={fix}>{fix}</li>
                  ))}
                </ul>
              </div>

              <div className="mt-3 text-xs">
                <span className="font-medium">Required headers:</span>{" "}
                <code className="text-muted-foreground font-mono">
                  {vendor.signatureHeaders.join(", ")}
                </code>
              </div>

              <div className="mt-3 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleCopyHeaders(vendor)}
                  disabled={copyingHeaders === vendor.id}
                >
                  {copyingHeaders === vendor.id ? "Copying…" : "Copy required headers"}
                </Button>
              </div>
            </section>
          ))}

          <div className="border-t pt-4">
            <h3 className="text-sm font-semibold">Not lead-import sources</h3>
            <p className="text-muted-foreground mt-1 text-xs">
              These get detected so you don&apos;t waste time mapping columns
              that won&apos;t validate, but they aren&apos;t lead exports.
            </p>
            <ul className="mt-3 flex flex-col gap-2 text-xs">
              {nonImportable.map((vendor) => (
                <li key={vendor.id} className="rounded-md border bg-muted/30 p-3">
                  <div className="font-medium">{vendor.label}</div>
                  <div className="text-muted-foreground">{vendor.description}</div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
