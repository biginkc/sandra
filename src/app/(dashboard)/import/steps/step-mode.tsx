"use client";

import { DatabaseIcon, PencilIcon } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

import type { WizardAction, WizardMode, WizardState } from "../wizard";

type Props = { state: WizardState; dispatch: React.Dispatch<WizardAction> };

const MODES: Array<{
  id: WizardMode;
  title: string;
  description: string;
  icon: typeof DatabaseIcon;
  testId: string;
}> = [
  {
    id: "add",
    title: "Add new Prospects",
    description:
      "Bring a new file of properties into Sandra. New addresses become Prospects; addresses Sandra already has are matched, not duplicated. Nothing already in Sandra is changed.",
    icon: DatabaseIcon,
    testId: "mode-add",
  },
  {
    id: "update",
    title: "Update existing records",
    description:
      "Change records Sandra already has. Creates nothing new. Rows that don't match an existing record are skipped and reported.",
    icon: PencilIcon,
    testId: "mode-update",
  },
];

export function StepMode({ state, dispatch }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Choose an operation</CardTitle>
        <CardDescription>
          Pick a mode. You can change it by clicking Back.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-4 sm:grid-cols-2">
          {MODES.map((m) => {
            const Icon = m.icon;
            const selected = state.mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                data-testid={m.testId}
                onClick={() => dispatch({ type: "SET_MODE", mode: m.id })}
                className={cn(
                  "border-input hover:border-foreground/30 hover:bg-muted/30 flex flex-col items-start gap-2 rounded-md border p-4 text-left transition-colors",
                  selected && "border-primary bg-primary/5",
                )}
              >
                <Icon
                  className={cn(
                    "size-6",
                    selected ? "text-primary" : "text-muted-foreground",
                  )}
                />
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{m.title}</span>
                  <span className="text-muted-foreground text-xs">
                    {m.description}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
