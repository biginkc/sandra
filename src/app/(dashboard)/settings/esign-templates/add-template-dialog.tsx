"use client";

import { FileUpIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { validateTemplateTitle } from "@/lib/esign/template-contract";

import { SignerRoleEditor } from "./signer-role-editor";
import {
  ESIGN_MERGE_FIELD_NAMES,
  type TemplateLibraryActions,
  type TemplateSignerRole,
  type TemplateSource,
} from "./types";

const DOCUMENT_TYPES = [
  "Purchase agreement",
  "Assignment",
  "Access agreement",
  "Addendum",
  "Other",
] as const;
const MAX_PDF_BYTES = 40 * 1024 * 1024;

export function AddTemplateDialog({
  actions,
  disabledReason,
  trigger,
}: {
  actions?: TemplateLibraryActions;
  disabledReason?: string;
  trigger?: ReactNode;
}) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [documentType, setDocumentType] = useState<(typeof DOCUMENT_TYPES)[number]>("Purchase agreement");
  const [source, setSource] = useState<TemplateSource | null>(null);
  const [roles, setRoles] = useState<readonly TemplateSignerRole[]>([
    { name: "Seller", order: 0 },
  ]);
  const [sellerRoleName, setSellerRoleName] = useState("Seller");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const validationError = useMemo(
    () => validateDraft({ name, source, roles, sellerRoleName }),
    [name, source, roles, sellerRoleName],
  );

  const acceptFile = (file: File | null, origin: TemplateSource["origin"]) => {
    if (!file) return;
    const fileError = validatePdf(file);
    if (fileError) {
      setError(fileError);
      return;
    }
    setError(null);
    setSource({ file, origin });
    if (!name.trim()) setName(file.name.replace(/\.pdf$/i, ""));
  };

  const pickDropbox = () => {
    if (!actions) return;
    startTransition(async () => {
      const result = await actions.pickDropboxPdf();
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      acceptFile(result.data, "dropbox");
    });
  };

  const submit = () => {
    if (!actions || !source || validationError) return;
    startTransition(async () => {
      const result = await actions.createDraft({
        name: name.trim(),
        documentType,
        source,
        signerRoles: roles.map((role, order) => ({ name: role.name.trim(), order })),
        sellerRoleName,
        mergeFieldNames: ESIGN_MERGE_FIELD_NAMES,
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setOpen(false);
      router.push(`/settings/esign-templates/${result.data.templateId}/edit`);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button type="button" onClick={() => setOpen(true)} disabled={Boolean(disabledReason)} title={disabledReason}>
        {trigger ?? <><PlusIcon data-icon="inline-start" /> Add template</>}
      </Button>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add eSign template</DialogTitle>
          <DialogDescription>
            Upload one PDF and define every signer role required by Dropbox Sign.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="esign-template-name">Template name</Label>
            <Input id="esign-template-name" value={name} onChange={(event) => setName(event.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="esign-document-type">Document type</Label>
            <select id="esign-document-type" value={documentType} onChange={(event) => setDocumentType(event.target.value as (typeof DOCUMENT_TYPES)[number])} className="border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm">
              {DOCUMENT_TYPES.map((type) => <option key={type}>{type}</option>)}
            </select>
          </div>
          <div className="space-y-2">
            <Label>PDF source</Label>
            <input ref={fileInput} type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(event) => acceptFile(event.target.files?.[0] ?? null, "upload")} aria-label="Upload PDF" />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                <FileUpIcon data-icon="inline-start" /> Upload PDF
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={pickDropbox} disabled={!actions || pending}>
                Choose from Dropbox
              </Button>
            </div>
            {source && <p className="text-muted-foreground text-xs">{source.file.name} · {formatBytes(source.file.size)} · {source.origin === "dropbox" ? "Dropbox" : "Uploaded"}</p>}
          </div>

          <SignerRoleEditor roles={roles} sellerRoleName={sellerRoleName} onChange={(nextRoles, nextSeller) => { setRoles(nextRoles); setSellerRoleName(nextSeller); }} />

          <div className="bg-muted/50 rounded-lg border p-3 text-xs">
            <p className="font-medium">Merge fields included</p>
            <p className="text-muted-foreground mt-1 font-mono">{ESIGN_MERGE_FIELD_NAMES.join(" · ")}</p>
          </div>

          {(error || validationError || disabledReason) && (
            <p role="alert" className="text-destructive text-sm">{error ?? validationError ?? disabledReason}</p>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" disabled={pending} />}>Cancel</DialogClose>
          <Button type="button" onClick={submit} disabled={!actions || pending || Boolean(validationError)}>
            {pending ? "Preparing…" : "Upload and place fields"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function validatePdf(file: File): string | null {
  if (!file.name.toLowerCase().endsWith(".pdf")) return "Choose a PDF file.";
  if (file.type && file.type !== "application/pdf") return "Choose a PDF file.";
  if (file.size <= 0) return "The PDF is empty.";
  if (file.size > MAX_PDF_BYTES) return "The PDF must be 40 MB or smaller.";
  return null;
}

function validateDraft(input: { name: string; source: TemplateSource | null; roles: readonly TemplateSignerRole[]; sellerRoleName: string }): string | null {
  const titleError = validateTemplateTitle(input.name);
  if (titleError) return titleError;
  if (!input.source) return "Choose a PDF.";
  const names = input.roles.map((role) => role.name.trim());
  if (names.some((name) => !name)) return "Every signer role needs a name.";
  if (new Set(names.map((name) => name.toLocaleLowerCase())).size !== names.length) return "Signer role names must be unique.";
  if (!names.includes(input.sellerRoleName)) return "Choose the seller role.";
  return null;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
