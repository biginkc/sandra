"use client";

import { useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { buildCoachSectionScriptBlock } from "@/lib/coach/script-block";
import {
  EMPTY_ENTRY_FIELDS,
  resolveCoachTokens,
  type DisplayTextSegment,
} from "@/lib/coach/token-resolver";
import { COACH_ENTRY_TOKENS, type ResolvedToken } from "@/lib/coach/types";
import { getCoachSections } from "@/lib/coach/section-manifest";

import type { CallScreenScript, Section } from "./types";

export type StaticScriptViewProps = {
  script: Section<CallScreenScript>;
  entryFields: Record<string, string | null>;
  onEntryFieldChange?: (token: string, value: string) => void;
};

const ENTRY_TOKEN_SET: ReadonlySet<string> = new Set(COACH_ENTRY_TOKENS);

export function StaticScriptView({ script, entryFields, onEntryFieldChange }: StaticScriptViewProps) {
  if (!script.ok) {
    return (
      <div data-testid="static-script-view" className="rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">Script unavailable</h2>
        <p className="text-muted-foreground text-sm">{script.message}</p>
      </div>
    );
  }
  return <ScriptBody data={script.data} entryFields={entryFields} onEntryFieldChange={onEntryFieldChange} />;
}

function ScriptBody({
  data,
  entryFields,
  onEntryFieldChange,
}: {
  data: CallScreenScript;
  entryFields: Record<string, string | null>;
  onEntryFieldChange?: (token: string, value: string) => void;
}) {
  const { bundle, context } = data;
  const [branchOverrides, setBranchOverrides] = useState<Record<string, string>>({});

  const sections = useMemo(() => getCoachSections(bundle), [bundle]);
  const blocks = useMemo(() => {
    const tokens = resolveCoachTokens(bundle.script.tokens, context, { ...EMPTY_ENTRY_FIELDS, ...entryFields });
    const selectCtx = { leadSource: context.leadSource, occupancy: context.occupancy };
    return sections.map((section) => ({
      section,
      block: buildCoachSectionScriptBlock(bundle, section.id, tokens, selectCtx, branchOverrides, null),
    }));
  }, [bundle, context, entryFields, sections, branchOverrides]);

  return (
    <div data-testid="static-script-view" className="flex flex-col gap-4">
      <nav
        data-testid="script-section-rail"
        aria-label="Script sections"
        style={{ position: "sticky", top: 0 }}
        className="z-10 flex flex-wrap gap-2 border-b border-border bg-background py-2"
      >
        {sections.map((section) => (
          <a
            key={section.id}
            href={`#script-section-${section.id}`}
            className="text-muted-foreground hover:text-foreground rounded-full border border-border px-2.5 py-0.5 text-xs"
          >
            {section.title}
          </a>
        ))}
      </nav>
      {blocks.map(({ section, block }) => (
        <section key={section.id} id={`script-section-${section.id}`} data-testid={`script-section-${section.id}`}>
          <Card className="flex flex-col gap-3 p-4">
            <header>
              <h2 className="text-base font-semibold">{block?.title ?? section.title}</h2>
              {block?.purpose ? <p className="text-muted-foreground text-sm">{block.purpose}</p> : null}
            </header>
            {block?.branches.map((branch) => (
              <div key={branch.tag} className="flex flex-col gap-1.5">
                {branch.variantOptions.length > 1 ? (
                  <div className="flex flex-wrap gap-1" role="group" aria-label={`Variant for ${branch.tag}`}>
                    {branch.variantOptions.map((option) => (
                      <Button
                        key={option.key}
                        type="button"
                        size="sm"
                        variant={option.key === branch.selected.key ? "default" : "outline"}
                        aria-pressed={option.key === branch.selected.key}
                        onClick={() => setBranchOverrides((prev) => ({ ...prev, [branch.tag]: option.key }))}
                      >
                        {option.label ?? option.key}
                      </Button>
                    ))}
                  </div>
                ) : null}
                {branch.selected.lines.map((line, index) =>
                  line.type === "say" ? (
                    <p key={line.id ?? index} className="font-bold">
                      <Segments segments={line.segments} onEntryFieldChange={onEntryFieldChange} />
                    </p>
                  ) : (
                    <p key={line.id ?? index} className="text-muted-foreground text-sm">
                      <Segments segments={line.segments} onEntryFieldChange={onEntryFieldChange} />
                    </p>
                  ),
                )}
                {branch.trailingNote ? (
                  <p className="text-muted-foreground text-sm">
                    <Segments segments={branch.trailingNote} onEntryFieldChange={onEntryFieldChange} />
                  </p>
                ) : null}
              </div>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}

function Segments({
  segments,
  onEntryFieldChange,
}: {
  segments: DisplayTextSegment[];
  onEntryFieldChange?: (token: string, value: string) => void;
}) {
  return (
    <>
      {segments.map((segment, index) => {
        if (segment.kind === "text") return <span key={index}>{segment.value}</span>;
        if (segment.kind === "tone") return <ToneChip key={index} text={segment.label} />;
        return (
          <TokenChip
            key={index}
            token={segment.token}
            resolved={segment.resolved}
            onEntryFieldChange={onEntryFieldChange}
          />
        );
      })}
    </>
  );
}

function ToneChip({ text }: { text: string }) {
  return (
    <span
      data-testid="tone-chip"
      className="inline-flex items-center rounded-full border-0 bg-[var(--coach-amber)] px-2.5 py-0.5 text-[11px] font-bold text-[var(--coach-rail)]"
    >
      {text}
    </span>
  );
}

function PlaceholderChip({ resolved }: { resolved: ResolvedToken }) {
  return (
    <span
      data-testid="token-placeholder"
      className="mx-0.5 inline-flex items-center rounded-full border border-dashed border-border bg-transparent px-1.5 py-0 text-[11px] text-muted-foreground"
    >
      missing<span className="sr-only">{resolved.value}</span>
    </span>
  );
}

function TokenChip({
  token,
  resolved,
  onEntryFieldChange,
}: {
  token: string;
  resolved: ResolvedToken;
  onEntryFieldChange?: (token: string, value: string) => void;
}) {
  if (ENTRY_TOKEN_SET.has(token) && onEntryFieldChange) {
    return <EntryChip token={token} resolved={resolved} onCommit={(value) => onEntryFieldChange(token, value)} />;
  }
  if (resolved.isPlaceholder) return <PlaceholderChip resolved={resolved} />;
  return (
    <span data-testid="token-resolved" className="font-bold text-[var(--coach-sky)]">
      {resolved.value}
    </span>
  );
}

function EntryChip({
  token,
  resolved,
  onCommit,
}: {
  token: string;
  resolved: ResolvedToken;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  if (editing) {
    const commit = () => {
      setEditing(false);
      const value = draft.trim();
      if (value && value !== resolved.value) onCommit(value);
    };
    return (
      <input
        autoFocus
        data-testid="token-entry-input"
        aria-label={token}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setEditing(false);
        }}
        className="mx-0.5 inline-block w-40 rounded border border-border bg-background px-1 text-sm"
      />
    );
  }
  return (
    <button
      type="button"
      data-testid="token-entry"
      data-token={token}
      onClick={() => {
        setDraft(resolved.isPlaceholder ? "" : resolved.value);
        setEditing(true);
      }}
      className="font-bold text-[var(--coach-sky)] underline decoration-dotted"
    >
      {resolved.isPlaceholder ? "missing" : resolved.value}
    </button>
  );
}
