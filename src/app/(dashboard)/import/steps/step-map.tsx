"use client";

import { Check, ChevronsUpDown } from "lucide-react";
import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AGENT_FIELDS,
  HOMEOWNER_FIELDS,
  PROPERTY_FIELDS,
  type TargetField,
} from "@/lib/csv/schema";
import { cn } from "@/lib/utils";

import type { WizardAction, WizardState } from "../wizard";

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

export function StepMap({ state, dispatch }: Props) {
  const mappedCount = Object.values(state.mapping).filter(Boolean).length;
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center justify-between">
            <span>Detected columns</span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => dispatch({ type: "AUTODETECT_MAPPING" })}
            >
              Re-run autodetect
            </Button>
          </CardTitle>
          <CardDescription>
            {state.headers.length} columns in the CSV · {mappedCount} auto-mapped
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-1.5">
            {state.headers.map((h) => (
              <Badge key={h} variant="secondary" className="font-mono text-xs">
                {h}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <SectionCard
        title="Property"
        description="Required. Either map Address + State separately, or map the Full Address (combined) column and we'll auto-split it. Other fields are optional."
        fields={PROPERTY_FIELDS}
        state={state}
        dispatch={dispatch}
      />
      <SectionCard
        title="Homeowner"
        description="Optional. Leave unmapped for driving-for-dollars / tax-record imports that don't include owner data."
        fields={HOMEOWNER_FIELDS}
        state={state}
        dispatch={dispatch}
      />
      <SectionCard
        title="Agent"
        description="Optional. Usually only populated on MLS / Zillow exports."
        fields={AGENT_FIELDS}
        state={state}
        dispatch={dispatch}
      />
    </div>
  );
}

function SectionCard({
  title,
  description,
  fields,
  state,
  dispatch,
}: {
  title: string;
  description: string;
  fields: readonly TargetField[];
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const mappedCount = fields.filter((f) => !!state.mapping[f.id]).length;
  const requiredCount = fields.filter((f) => f.required).length;
  // A mapped `address_full` column satisfies both the `address` and `state`
  // requirements by derivation — credit it in the counter so the user sees
  // `2/2 required` when only Full Address is mapped.
  const addressFullSatisfies =
    !!state.mapping.address_full &&
    fields.some((f) => f.id === "address_full");
  const requiredMapped = fields.filter((f) => {
    if (!f.required) return false;
    if (state.mapping[f.id]) return true;
    if (
      addressFullSatisfies &&
      (f.id === "address" || f.id === "state")
    )
      return true;
    return false;
  }).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>{title}</span>
          <span className="text-muted-foreground text-sm font-normal">
            {mappedCount} of {fields.length} mapped
            {requiredCount > 0 && (
              <> · {requiredMapped}/{requiredCount} required</>
            )}
          </span>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {fields.map((field) => (
            <FieldRow
              key={field.id}
              field={field}
              state={state}
              dispatch={dispatch}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const DERIVABLE_FROM_ADDRESS_FULL: ReadonlySet<string> = new Set([
  "address",
  "city",
  "state",
  "zip",
]);

function FieldRow({
  field,
  state,
  dispatch,
}: {
  field: TargetField;
  state: WizardState;
  dispatch: React.Dispatch<WizardAction>;
}) {
  const currentHeader = state.mapping[field.id] ?? null;

  // When the user has mapped a combined-address column, signal that Address /
  // City / State / ZIP will be auto-filled from it even if left "(not mapped)".
  // Suppresses the "required" warning and the confusion of seeing a required
  // field that looks unmapped.
  const addressFullHeader = state.mapping.address_full ?? null;
  const willDerive =
    !!addressFullHeader &&
    DERIVABLE_FROM_ADDRESS_FULL.has(field.id) &&
    !currentHeader;

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={`map-${field.id}`} className="flex items-center gap-2">
        {field.label}
        {field.required && !willDerive && (
          <span className="text-destructive text-xs">required</span>
        )}
        {willDerive && (
          <span className="text-emerald-600 text-xs dark:text-emerald-400">
            auto-filled from Full Address
          </span>
        )}
      </Label>
      <HeaderCombobox
        triggerId={`map-${field.id}`}
        headers={state.headers}
        value={currentHeader}
        derivedFrom={willDerive ? addressFullHeader : null}
        onChange={(header) =>
          dispatch({
            type: "SET_MAPPING_FIELD",
            fieldId: field.id,
            header,
          })
        }
      />
      {field.helpText && (
        <div className="text-muted-foreground text-xs">{field.helpText}</div>
      )}
    </div>
  );
}

/**
 * Searchable column-mapping dropdown. Native <select> scrolling is brutal
 * on Skip Genie / DataTree (D4D) files that ship 200+ columns; cmdk's
 * Command does fuzzy filter-as-you-type out of the box. Selecting "(not
 * mapped)" resets the field by passing null to onChange — different from
 * not selecting anything, which preserves the current value.
 */
function HeaderCombobox({
  triggerId,
  headers,
  value,
  derivedFrom,
  onChange,
}: {
  triggerId: string;
  headers: readonly string[];
  value: string | null;
  /** When the field will be auto-filled from the combined-address column,
   *  show that source as the placeholder instead of "(not mapped)". */
  derivedFrom: string | null;
  onChange: (header: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);

  const placeholder = derivedFrom ? `← ${derivedFrom}` : "(not mapped)";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={triggerId}
        render={
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal"
          />
        }
      >
        <span
          className={cn(
            "truncate",
            !value && "text-muted-foreground",
          )}
        >
          {value ?? placeholder}
        </span>
        <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--anchor-size)] min-w-[280px] p-0"
      >
        <Command>
          <CommandInput placeholder="Search columns…" />
          <CommandList>
            <CommandEmpty>No columns match.</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value="__not_mapped__"
                onSelect={() => {
                  onChange(null);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn(
                    "mr-2 size-4",
                    value === null ? "opacity-100" : "opacity-0",
                  )}
                />
                (not mapped)
              </CommandItem>
              {headers.map((h) => (
                <CommandItem
                  key={h}
                  value={h}
                  onSelect={() => {
                    onChange(h);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 size-4",
                      value === h ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{h}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
