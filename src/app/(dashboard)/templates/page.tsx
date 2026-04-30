import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";

import { listTemplates, listCategories } from "./actions";
import { NewTemplateButton } from "./new-template-button";
import { TemplatesList } from "./templates-list";

export default async function TemplatesPage() {
  const [templatesResult, categoriesResult] = await Promise.all([
    listTemplates(),
    listCategories(),
  ]);

  const templates = templatesResult.ok ? templatesResult.data : [];
  const categories = categoriesResult.ok ? categoriesResult.data : [];

  return (
    <Page>
      <PageHeader
        breadcrumb={[{ label: "Workspace" }, { label: "Templates" }]}
        title="Templates"
        description="Reusable SMS templates with variable interpolation. Use {{first_name | fallback}} syntax for personalization."
        actions={<NewTemplateButton />}
      />

      {!templatesResult.ok && (
        <div className="text-destructive text-sm">
          Failed to load templates: {templatesResult.error.message}
        </div>
      )}

      <TemplatesList templates={templates} categories={categories} />
    </Page>
  );
}
