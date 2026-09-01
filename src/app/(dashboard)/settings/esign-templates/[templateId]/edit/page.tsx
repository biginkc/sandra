import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { loadTemplateEditor } from "../../template-lane-adapter";
import { InitialSessionEmbeddedTemplateEditor } from "./embedded-template-editor";

export default async function EditEsignTemplatePage({
  params,
}: {
  params: Promise<{ templateId: string }>;
}) {
  const { templateId } = await params;
  const result = await loadTemplateEditor(templateId);

  return (
    <Page className="max-w-none">
      {result.ok ? (
        <InitialSessionEmbeddedTemplateEditor template={result.data} />
      ) : (
        <>
          <PageHeader
            breadcrumb={[
              { label: "Settings", href: "/settings/integrations" },
              { label: "eSign templates", href: "/settings/esign-templates" },
              { label: "Edit" },
            ]}
            title="Edit eSign template"
            description="Finish field placement inside Dropbox Sign, then synchronize the template back to Sandra."
          />
          <div
            role="alert"
            className="border-destructive/30 bg-destructive/5 rounded-xl border p-6"
          >
            <h2 className="font-medium">Could not load this template</h2>
            <p className="text-muted-foreground mt-1 text-sm">
              {result.error.message}
            </p>
            <p className="text-muted-foreground mt-2 font-mono text-xs">
              {result.error.code}
            </p>
          </div>
        </>
      )}
    </Page>
  );
}
