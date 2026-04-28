"use client";

import { useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import {
  SUB_OPERATIONS,
  type SubOperationId,
  type SubOperationModule,
} from "@/lib/csv/update-operations";

import { ExampleTemplateDialog } from "../example-template-dialog";
import type { WizardAction, WizardState } from "../wizard";

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

export function StepSubOperation({ state, dispatch }: Props) {
  const [exampleFor, setExampleFor] = useState<SubOperationModule | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>What do you want to update?</CardTitle>
        <CardDescription>
          Pick one. Each option matches rows by property address — see the
          example template for the columns your sheet needs.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-2">
          {SUB_OPERATIONS.map((op) => {
            const selected = state.subOperation === op.id;
            return (
              <li
                key={op.id}
                className={cn(
                  "border-input flex items-start justify-between gap-3 rounded-md border p-3 transition-colors",
                  selected && "border-primary bg-primary/5",
                )}
              >
                <button
                  type="button"
                  data-testid={`subop-${op.id}`}
                  onClick={() =>
                    dispatch({
                      type: "SET_SUB_OPERATION",
                      subOperation: op.id as SubOperationId,
                    })
                  }
                  className="flex flex-1 flex-col gap-1 text-left"
                >
                  <span className="text-sm font-medium">{op.label}</span>
                  <span className="text-muted-foreground text-xs">
                    {op.description}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    Required:{" "}
                    <code className="font-mono">
                      {op.requiredColumns.join(", ")}
                    </code>
                  </span>
                </button>
                <button
                  type="button"
                  className="text-primary text-xs font-medium hover:underline"
                  onClick={(e) => {
                    e.stopPropagation();
                    setExampleFor(op);
                  }}
                  data-testid={`subop-${op.id}-example`}
                >
                  See example
                </button>
              </li>
            );
          })}
        </ul>
      </CardContent>

      <ExampleTemplateDialog
        open={!!exampleFor}
        onOpenChange={(o) => !o && setExampleFor(null)}
        subOperation={exampleFor}
      />
    </Card>
  );
}
