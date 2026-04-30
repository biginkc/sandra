"use client";

import { Search } from "lucide-react";
import { useState, useMemo } from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { type TemplateRow } from "./actions";
import { TemplateDialog } from "./template-dialog";
import { DeleteTemplateButton } from "./delete-template-button";

type Props = {
  templates: TemplateRow[];
  categories: string[];
};

export function TemplatesList({ templates, categories }: Props) {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [editingTemplate, setEditingTemplate] = useState<TemplateRow | null>(
    null,
  );

  const filtered = useMemo(() => {
    let result = templates;
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.content.toLowerCase().includes(q),
      );
    }
    if (categoryFilter !== "all") {
      result = result.filter((t) => t.category === categoryFilter);
    }
    return result;
  }, [templates, search, categoryFilter]);

  return (
    <>
      {/* Filters */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="text-muted-foreground absolute left-3 top-1/2 size-4 -translate-y-1/2" />
          <Input
            placeholder="Search templates…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            id="template-search"
          />
        </div>
        <Select value={categoryFilter} onValueChange={(v) => setCategoryFilter(v ?? "all")}>
          <SelectTrigger className="w-full sm:w-[180px]" id="category-filter">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="text-muted-foreground py-12 text-center text-sm">
          {templates.length === 0
            ? 'No templates yet. Click "New template" to create one.'
            : "No templates match your search."}
        </div>
      ) : (
        <div className="border-border overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase">
              <tr>
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Category</th>
                <th className="hidden px-3 py-2 md:table-cell">Preview</th>
                <th className="px-3 py-2">Updated</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id} className="border-border border-t">
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setEditingTemplate(t)}
                      className="font-medium hover:underline"
                    >
                      {t.name}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">{t.category}</Badge>
                  </td>
                  <td className="text-muted-foreground hidden max-w-[300px] truncate px-3 py-2 md:table-cell">
                    {t.content.slice(0, 80)}
                    {t.content.length > 80 ? "…" : ""}
                  </td>
                  <td className="text-muted-foreground whitespace-nowrap px-3 py-2 text-xs">
                    {formatRelative(t.updated_at)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setEditingTemplate(t)}
                      >
                        Edit
                      </Button>
                      <DeleteTemplateButton
                        templateId={t.id}
                        templateName={t.name}
                      />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit dialog */}
      {editingTemplate && (
        <TemplateDialog
          mode="edit"
          template={editingTemplate}
          open={!!editingTemplate}
          onOpenChange={(open) => {
            if (!open) setEditingTemplate(null);
          }}
        />
      )}
    </>
  );
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}
