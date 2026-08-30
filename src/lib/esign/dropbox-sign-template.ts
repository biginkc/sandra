import "server-only";

import {
  EmbeddedApi,
  HttpError,
  SubMergeField,
  TemplateApi,
} from "@dropbox/sign";

import { ProviderError } from "@/lib/errors/classes";
import { requireTemplateTitle } from "@/lib/esign/template-contract";

import {
  ESIGN_MERGE_FIELD_NAMES,
  type CreateEmbeddedTemplateDraftInput,
  type EmbeddedTemplateSession,
  type ProviderTemplateMetadata,
  type TemplatePdf,
} from "./contracts";
import { EsignSecret } from "./secret";

export type DropboxSignTemplateProvider = Readonly<{
  createEmbeddedDraft(
    input: CreateEmbeddedTemplateDraftInput,
  ): Promise<EmbeddedTemplateSession>;
  getFreshEditUrl(providerTemplateId: string): Promise<EmbeddedTemplateSession>;
  getTemplate(providerTemplateId: string): Promise<ProviderTemplateMetadata>;
  downloadTemplatePdf(providerTemplateId: string): Promise<Buffer>;
  duplicateTemplate(
    providerTemplateId: string,
    source: TemplatePdf,
  ): Promise<{ providerTemplateId: string }>;
  deleteTemplate(providerTemplateId: string): Promise<void>;
}>;

export function createDropboxSignTemplateProvider(input: {
  apiKey: EsignSecret;
  clientId: string;
}): DropboxSignTemplateProvider {
  const embedded = new EmbeddedApi();
  const template = new TemplateApi();
  for (const api of [embedded, template]) {
    api.username = input.apiKey.reveal();
    api.password = "";
  }

  return {
    async createEmbeddedDraft(request) {
      try {
        const response = await template.templateCreateEmbeddedDraft({
          clientId: input.clientId,
          files: [providerFile(request.file)],
          title: requireTemplateTitle(request.title),
          signerRoles: request.signerRoles.map((role) => ({
            name: role.name,
            order: role.order,
          })),
          forceSignerRoles: true,
          mergeFields: ESIGN_MERGE_FIELD_NAMES.map((name) => ({
            name,
            type: SubMergeField.TypeEnum.Text,
          })),
          metadata: { sandra_template_id: request.localTemplateId },
          testMode: true,
        });
        const draft = response.body.template;
        if (!draft.templateId || !draft.editUrl) {
          throw new ProviderError(
            "Dropbox Sign did not return an embedded template session.",
            "dropbox_sign",
          );
        }
        return {
          providerTemplateId: draft.templateId,
          editUrl: draft.editUrl,
          expiresAt: draft.expiresAt ?? null,
        };
      } catch (error) {
        throw normalizeTemplateProviderError(error);
      }
    },

    async getFreshEditUrl(providerTemplateId) {
      try {
        // Deliberately omit mergeFields. Sending [] removes provider fields,
        // and resending the seed list on an ordinary reopen can overwrite the
        // provider-authoritative editor state.
        const response = await embedded.embeddedEditUrl(providerTemplateId, {
          forceSignerRoles: true,
          testMode: true,
        });
        const session = response.body.embedded;
        if (!session.editUrl) {
          throw new ProviderError(
            "Dropbox Sign did not return a fresh template edit URL.",
            "dropbox_sign",
          );
        }
        return {
          providerTemplateId,
          editUrl: session.editUrl,
          expiresAt: session.expiresAt ?? null,
        };
      } catch (error) {
        throw normalizeTemplateProviderError(error);
      }
    },

    async getTemplate(providerTemplateId) {
      try {
        const provider = (await template.templateGet(providerTemplateId)).body
          .template;
        return {
          providerTemplateId: provider.templateId ?? providerTemplateId,
          title: provider.title ?? null,
          signerRoles: (provider.signerRoles ?? [])
            .map((role, index) => ({
              name: role.name ?? "",
              order: role.order ?? index,
            }))
            .sort((left, right) => left.order - right.order),
          mergeFieldNames: (provider.namedFormFields ?? []).flatMap((field) =>
            field.name ? [field.name] : [],
          ),
        };
      } catch (error) {
        throw normalizeTemplateProviderError(error);
      }
    },

    async downloadTemplatePdf(providerTemplateId) {
      try {
        return (await template.templateFiles(providerTemplateId, "pdf")).body;
      } catch (error) {
        throw normalizeTemplateProviderError(error);
      }
    },

    async duplicateTemplate(providerTemplateId, source) {
      try {
        const duplicate = await template.templateUpdateFiles(providerTemplateId, {
          clientId: input.clientId,
          files: [providerFile(source)],
          testMode: true,
        });
        const duplicateId = duplicate.body.template?.templateId;
        if (!duplicateId || duplicateId === providerTemplateId) {
          throw new ProviderError(
            "Dropbox Sign did not return a distinct copied template identifier.",
            "dropbox_sign",
            { providerCode: "template_copy_id_missing" },
          );
        }
        return { providerTemplateId: duplicateId };
      } catch (error) {
        throw normalizeTemplateProviderError(error);
      }
    },

    async deleteTemplate(providerTemplateId) {
      try {
        await template.templateDelete(providerTemplateId);
      } catch (error) {
        throw normalizeTemplateProviderError(error);
      }
    },
  };
}

function providerFile(file: TemplatePdf) {
  return {
    value: file.bytes,
    options: {
      filename: file.filename,
      contentType: "application/pdf",
      knownLength: file.bytes.byteLength,
    },
  };
}

export function normalizeTemplateProviderError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof HttpError) {
    const retryAfter = error.response?.headers?.["retry-after"];
    return new ProviderError(
      error.body?.error?.errorMsg || "Dropbox Sign rejected the template request.",
      "dropbox_sign",
      {
        providerCode: error.body?.error?.errorName,
        statusCode: error.statusCode,
        retryAfterSeconds:
          typeof retryAfter === "string" ? Number(retryAfter) : undefined,
        retryable: error.statusCode === 429 || (error.statusCode ?? 0) >= 500,
      },
    );
  }
  return new ProviderError(
    error instanceof Error
      ? error.message
      : "Dropbox Sign template request failed unexpectedly.",
    "dropbox_sign",
  );
}
