"use client";

import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { AddBlockPicker } from "@/app/(dashboard)/properties/_components/add-block-picker";
import { defaultBlockForKind } from "@/app/(dashboard)/properties/_components/filter-drawer";
import { BlockOptionsProvider } from "@/app/(dashboard)/properties/_components/block-options-provider";
import { renderBlock } from "@/app/(dashboard)/properties/_components/blocks/registry";
import type { BlockOptions } from "@/app/(dashboard)/properties/_components/blocks/_block-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/errors/call-action";
import type { FilterBlock } from "@/lib/prospects/filter-schema";

import { createCampaign } from "./actions";

type Props = {
  blockOptions: BlockOptions;
  templateCategories: Array<{ category: string; count: number }>;
};

type ValidationErrors = Partial<
  Record<"name" | "body" | "pace" | "audience", string>
>;

const DEFAULT_PACE_SECONDS = "18";

function parsePaceSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) return Number.NaN;
  return parsed;
}

export function CreateCampaignForm({
  blockOptions,
  templateCategories,
}: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [body, setBody] = useState("");
  const [templateCategory, setTemplateCategory] = useState("");
  const [paceSeconds, setPaceSeconds] = useState(DEFAULT_PACE_SECONDS);
  const [skipIfContacted, setSkipIfContacted] = useState(false);
  const [audienceSearch, setAudienceSearch] = useState("");
  const [blocks, setBlocks] = useState<FilterBlock[]>([]);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [errors, setErrors] = useState<ValidationErrors>({});
  const [pending, startTransition] = useTransition();

  const audienceSummary = useMemo(() => {
    const parts: string[] = [];
    if (audienceSearch.trim()) parts.push(`search "${audienceSearch.trim()}"`);
    if (blocks.length > 0) {
      parts.push(`${blocks.length} filter${blocks.length === 1 ? "" : "s"}`);
    }
    return parts.length > 0 ? parts.join(" + ") : "No audience yet";
  }, [audienceSearch, blocks]);

  const validate = (): ValidationErrors => {
    const nextErrors: ValidationErrors = {};
    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    const paceValue = parsePaceSeconds(paceSeconds);

    if (!trimmedName) {
      nextErrors.name = "Campaign name is required.";
    } else if (trimmedName.length > 80) {
      nextErrors.name = "Campaign names cap at 80 characters.";
    }

    if (!trimmedBody && !templateCategory) {
      nextErrors.body = "Write a message or choose a template pool.";
    }

    if (paceValue !== null && (!Number.isInteger(paceValue) || paceValue < 10 || paceValue > 600)) {
      nextErrors.pace = "Pacing must be between 10 seconds and 10 minutes.";
    }

    if (!audienceSearch.trim() && blocks.length === 0) {
      nextErrors.audience =
        "Add a search term or at least one audience filter.";
    }

    return nextErrors;
  };

  const updateBlock = (id: string, patch: Partial<FilterBlock>) => {
    setBlocks((current) =>
      current.map((block) =>
        block.id === id ? ({ ...block, ...patch } as FilterBlock) : block,
      ),
    );
  };

  const removeBlock = (id: string) => {
    setBlocks((current) => current.filter((block) => block.id !== id));
  };

  const resetForm = () => {
    setName("");
    setBody("");
    setTemplateCategory("");
    setPaceSeconds(DEFAULT_PACE_SECONDS);
    setSkipIfContacted(false);
    setAudienceSearch("");
    setBlocks([]);
    setErrors({});
  };

  const submit = () => {
    if (pending) return;

    const nextErrors = validate();
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;

    const trimmedName = name.trim();
    const trimmedBody = body.trim();
    const parsedPace = parsePaceSeconds(paceSeconds);

    startTransition(async () => {
      const result = await callAction(
        createCampaign({
          name: trimmedName,
          body: trimmedBody || null,
          templateCategory: templateCategory || null,
          paceSeconds: parsedPace,
          skipIfContacted,
          audience: {
            search: audienceSearch.trim() || null,
            blockStack: blocks,
          },
        }),
        {
          successMessage: `Created campaign "${trimmedName}"`,
          fallbackMessage: "Could not create campaign",
        },
      );

      if (result.ok) {
        resetForm();
        router.refresh();
      }
    });
  };

  return (
    <BlockOptionsProvider value={blockOptions}>
      <div className="border-border flex flex-col gap-4 rounded-md border p-4">
        <div className="text-sm font-semibold">New campaign</div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="campaign-new-name">Name</Label>
            <Input
              id="campaign-new-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. June Vacant Homes"
              maxLength={80}
              disabled={pending}
              aria-invalid={errors.name ? "true" : "false"}
            />
            {errors.name ? (
              <p className="text-destructive text-xs">{errors.name}</p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="campaign-template-category">
              Template pool (optional)
            </Label>
            <Select
              value={templateCategory}
              onValueChange={(value) => setTemplateCategory(value ?? "")}
              disabled={pending || templateCategories.length === 0}
            >
              <SelectTrigger id="campaign-template-category" className="w-full">
                <SelectValue placeholder="Pick a template pool" />
              </SelectTrigger>
              <SelectContent>
                {templateCategories.map((option) => (
                  <SelectItem key={option.category} value={option.category}>
                    {option.category} ({option.count})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              Optional fallback. If you type a message body too, the typed body
              wins at launch.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="campaign-new-body">Message body</Label>
          <Textarea
            id="campaign-new-body"
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Write the SMS this campaign should send."
            disabled={pending}
            aria-invalid={errors.body ? "true" : "false"}
          />
          {errors.body ? (
            <p className="text-destructive text-xs">{errors.body}</p>
          ) : (
            <p className="text-muted-foreground text-xs">
              Keep it final. This PR creates and launches campaigns, not a full editor.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[180px_auto] sm:items-end">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="campaign-pace-seconds">Pacing (seconds)</Label>
            <Input
              id="campaign-pace-seconds"
              type="number"
              min={10}
              max={600}
              step={1}
              value={paceSeconds}
              onChange={(event) => setPaceSeconds(event.target.value)}
              disabled={pending}
              aria-invalid={errors.pace ? "true" : "false"}
            />
            {errors.pace ? (
              <p className="text-destructive text-xs">{errors.pace}</p>
            ) : (
              <p className="text-muted-foreground text-xs">
                10 to 600 seconds between queued sends.
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={skipIfContacted}
              onChange={(event) => setSkipIfContacted(event.target.checked)}
              disabled={pending}
            />
            Skip prospects already contacted
          </label>
        </div>

        <div className="border-border relative rounded-md border p-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Audience</div>
              <div className="text-muted-foreground text-xs">
                {audienceSummary}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPickerOpen(true)}
              disabled={pending}
            >
              <PlusIcon className="mr-1 size-3.5" />
              Add filter
            </Button>
          </div>

          <div className="mb-3 flex flex-col gap-1.5">
            <Label htmlFor="campaign-audience-search">
              Search prospects (optional)
            </Label>
            <Input
              id="campaign-audience-search"
              value={audienceSearch}
              onChange={(event) => setAudienceSearch(event.target.value)}
              placeholder="Address search to narrow the saved audience"
              disabled={pending}
            />
          </div>

          {blocks.length === 0 ? (
            <div className="text-muted-foreground rounded border border-dashed p-4 text-sm">
              No audience filters yet. Add the same block filters operators use on Prospects.
            </div>
          ) : (
            <div className="space-y-3">
              {blocks.map((block) => (
                <div
                  key={block.id}
                  className="rounded border p-3"
                  data-testid="campaign-audience-block"
                >
                  {renderBlock(
                    block,
                    (patch) => updateBlock(block.id, patch),
                    () => removeBlock(block.id),
                  )}
                </div>
              ))}
            </div>
          )}

          {errors.audience ? (
            <p className="text-destructive mt-3 text-xs">{errors.audience}</p>
          ) : null}

          <AddBlockPicker
            open={pickerOpen}
            onClose={() => setPickerOpen(false)}
            onSelect={(kind) => {
              setBlocks((current) => [...current, defaultBlockForKind(kind)]);
              setPickerOpen(false);
            }}
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={submit} disabled={pending}>
            <PlusIcon className="mr-1 size-3.5" />
            {pending ? "Creating…" : "Create campaign"}
          </Button>
        </div>
      </div>
    </BlockOptionsProvider>
  );
}
