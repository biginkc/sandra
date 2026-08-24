"use client";

import { PlusIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { callAction } from "@/lib/errors/call-action";

import {
  applyPropertyTag,
  createCustomTag,
  listOrgTags,
  removePropertyTag,
  type TagRow,
} from "../tags-actions";

type AttachedTag = TagRow;

type Props = {
  propertyId: string;
  /** Tags already on this property, with the tag row joined. */
  initial: AttachedTag[];
};

const CATEGORY_LABELS: Record<TagRow["category"], string> = {
  source: "Source",
  marketing: "Marketing",
  skip_trace: "Skip trace",
  phone: "Phone",
  journey: "Journey",
  custom: "Custom",
};

const CATEGORY_ORDER: TagRow["category"][] = [
  "source",
  "marketing",
  "skip_trace",
  "phone",
  "journey",
  "custom",
];

/**
 * Strict-tag lead-detail section. Auto-applied categories render as
 * read-only chips (system provenance). The Custom row alone gets a
 * "+ Add tag" affordance — click to open an inline combobox of existing
 * custom tags plus a "create new" escape hatch.
 */
export function TagsSection({ propertyId, initial }: Props) {
  const router = useRouter();
  const [attached, setAttached] = useState<AttachedTag[]>(initial);
  const [catalog, setCatalog] = useState<TagRow[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, startTransition] = useTransition();

  // Lazy-load the full tag catalog the first time the user opens the adder.
  const loadCatalog = () => {
    if (catalogLoaded) return;
    listOrgTags().then((r) => {
      if (r.ok) {
        setCatalog(r.data);
        setCatalogLoaded(true);
      }
    });
  };

  useEffect(() => {
    if (adding) loadCatalog();
  }, [adding]); // eslint-disable-line react-hooks/exhaustive-deps

  const byCategory = useMemo(() => {
    const map: Record<TagRow["category"], AttachedTag[]> = {
      source: [],
      marketing: [],
      skip_trace: [],
      phone: [],
      journey: [],
      custom: [],
    };
    for (const t of attached) map[t.category].push(t);
    return map;
  }, [attached]);

  const trimmed = query.trim();
  const attachedIds = useMemo(() => new Set(attached.map((a) => a.id)), [attached]);
  const suggestions = useMemo(() => {
    if (!catalogLoaded) return [];
    return catalog
      .filter((c) => c.category === "custom" && !attachedIds.has(c.id))
      .filter((c) =>
        trimmed ? c.name.toLowerCase().includes(trimmed.toLowerCase()) : true,
      )
      .slice(0, 8);
  }, [catalog, catalogLoaded, trimmed, attachedIds]);
  const exactMatch = useMemo(
    () =>
      trimmed
        ? catalog.find((c) => c.name.toLowerCase() === trimmed.toLowerCase())
        : null,
    [catalog, trimmed],
  );

  const attach = (tag: TagRow) => {
    if (attachedIds.has(tag.id)) return;
    setAttached((prev) => [...prev, tag]); // optimistic
    setQuery("");
    setAdding(false);
    startTransition(async () => {
      const result = await callAction(
        applyPropertyTag(propertyId, tag.id),
        { fallbackMessage: "Could not apply tag" },
      );
      if (!result.ok) {
        setAttached((prev) => prev.filter((t) => t.id !== tag.id));
      } else {
        router.refresh();
      }
    });
  };

  const createAndAttach = () => {
    if (!trimmed || pending) return;
    startTransition(async () => {
      const result = await callAction(
        createCustomTag(trimmed, null),
        { fallbackMessage: "Could not create tag" },
      );
      if (!result.ok) return;
      const tag = result.data;
      setCatalog((prev) =>
        prev.some((c) => c.id === tag.id) ? prev : [...prev, tag],
      );
      attach(tag);
    });
  };

  const detach = (tag: AttachedTag) => {
    if (tag.system_managed) return; // UI already hides the X, but belt-and-suspenders
    setAttached((prev) => prev.filter((t) => t.id !== tag.id)); // optimistic
    startTransition(async () => {
      const result = await callAction(
        removePropertyTag(propertyId, tag.id),
        { fallbackMessage: "Could not remove tag" },
      );
      if (!result.ok) {
        // Put it back
        setAttached((prev) => [...prev, tag]);
      } else {
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      {CATEGORY_ORDER.map((cat) => {
        const tags = byCategory[cat];
        const isCustom = cat === "custom";
        if (tags.length === 0 && !isCustom) return null;
        return (
          <div
            key={cat}
            className="border-border/60 flex flex-wrap items-center gap-1.5 border-b px-3 py-2 last:border-b-0"
            data-slot="lead-tags-row"
          >
            <span className="text-muted-foreground mr-2 w-20 shrink-0 text-xs font-semibold tracking-wide uppercase">
              {CATEGORY_LABELS[cat]}
            </span>
            {tags.map((t) => (
              <TagChip
                key={t.id}
                tag={t}
                onRemove={isCustom ? () => detach(t) : undefined}
              />
            ))}
            {isCustom ? (
              adding ? (
                <AddForm
                  query={query}
                  setQuery={setQuery}
                  suggestions={suggestions}
                  exactMatch={exactMatch}
                  onPick={attach}
                  onCreate={createAndAttach}
                  onCancel={() => {
                    setAdding(false);
                    setQuery("");
                  }}
                  pending={pending}
                />
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setAdding(true)}
                  disabled={pending}
                >
                  <PlusIcon className="mr-1 size-3.5" />
                  Add tag
                </Button>
              )
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function TagChip({
  tag,
  onRemove,
}: {
  tag: TagRow;
  onRemove?: () => void;
}) {
  return (
    <Badge
      variant="secondary"
      className="text-[11px] gap-1"
      style={
        tag.color
          ? {
              backgroundColor: `${tag.color}22`,
              color: tag.color,
              borderColor: `${tag.color}55`,
            }
          : undefined
      }
    >
      <span>{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${tag.name}`}
          onClick={onRemove}
          className="-my-2 -mr-2 inline-flex size-9 items-center justify-center rounded-full hover:opacity-70"
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </Badge>
  );
}

function AddForm({
  query,
  setQuery,
  suggestions,
  exactMatch,
  onPick,
  onCreate,
  onCancel,
  pending,
}: {
  query: string;
  setQuery: (v: string) => void;
  suggestions: TagRow[];
  exactMatch: TagRow | null | undefined;
  onPick: (t: TagRow) => void;
  onCreate: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  return (
    <div className="relative">
      <Input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="tag name… (Enter to create)"
        disabled={pending}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (exactMatch) onPick(exactMatch);
            else if (query.trim()) onCreate();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="h-9 w-48 max-w-full text-xs"
      />
      {(suggestions.length > 0 || (query.trim() && !exactMatch)) && (
        <div className="bg-popover border-border absolute top-full left-0 z-10 mt-1 flex max-h-52 w-48 flex-col overflow-auto rounded-md border p-1 text-xs shadow-md">
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onPick(s)}
              disabled={pending}
              className="hover:bg-muted rounded px-2 py-1 text-left"
            >
              {s.name}
            </button>
          ))}
          {query.trim() && !exactMatch ? (
            <button
              type="button"
              onClick={onCreate}
              disabled={pending}
              className="hover:bg-muted text-muted-foreground rounded px-2 py-1 text-left italic"
            >
              + Create &ldquo;{query.trim()}&rdquo;
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
