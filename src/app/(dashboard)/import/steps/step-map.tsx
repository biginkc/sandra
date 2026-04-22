"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import {
  AGENT_FIELDS,
  HOMEOWNER_FIELDS,
  PROPERTY_FIELDS,
  type TargetField,
} from "@/lib/csv/schema";

import type { WizardAction, WizardState } from "../wizard";

const IGNORE_VALUE = "__ignore__";

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
  const triggerValue = currentHeader ?? IGNORE_VALUE;

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
      <Select
        value={triggerValue}
        onValueChange={(v) =>
          dispatch({
            type: "SET_MAPPING_FIELD",
            fieldId: field.id,
            header: v === IGNORE_VALUE ? null : v,
          })
        }
      >
        <SelectTrigger id={`map-${field.id}`} className="w-full">
          <span
            className={
              currentHeader ? "truncate" : "text-muted-foreground truncate"
            }
          >
            {currentHeader ?? (willDerive ? `← ${addressFullHeader}` : "(not mapped)")}
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={IGNORE_VALUE}>(not mapped)</SelectItem>
          {state.headers.map((h) => (
            <SelectItem key={h} value={h}>
              {h}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {field.helpText && (
        <div className="text-muted-foreground text-xs">{field.helpText}</div>
      )}
    </div>
  );
}
