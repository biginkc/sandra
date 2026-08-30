import { PlusIcon } from "lucide-react";

import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { AddTemplateDialog } from "./add-template-dialog";
import { loadPendingTemplateCopies, loadTemplateLibrary } from "./template-lane-adapter";
import { TemplateLibrary } from "./template-library";
import { PendingTemplateCopies } from "./pending-template-copies";

export default async function EsignTemplatesPage() {
  const [result, pendingCopies] = await Promise.all([
    loadTemplateLibrary(),
    loadPendingTemplateCopies(),
  ]);

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Settings", href: "/settings/integrations" },
          { label: "eSign templates" },
        ]}
        title="eSign templates"
        description="Manage the test-mode Dropbox Sign templates used to prepare offers and agreements."
        actions={
          <AddTemplateDialog
            disabledReason={
              result.ok && pendingCopies.ok
                ? undefined
                : "Templates and pending copies must load before another template can be added."
            }
            trigger={
              <>
                <PlusIcon data-icon="inline-start" />
                Add template
              </>
            }
          />
        }
      />

      <div className="border-alert-warning/40 bg-alert-warning/10 text-foreground flex flex-col gap-1 rounded-xl border px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
        <span>
          <strong>Dropbox Sign test mode.</strong> Documents are watermarked and
          are not legally binding.
        </span>
        <a
          href="/settings/integrations"
          className="font-medium underline underline-offset-4"
        >
          Integration settings
        </a>
      </div>

      <PendingTemplateCopies result={pendingCopies} />
      <TemplateLibrary result={result} actions={pendingCopies.ok ? undefined : null} />
    </Page>
  );
}
