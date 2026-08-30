import "server-only";

import {
  AccountApi,
  ApiAppApi,
  EmbeddedApi,
  HttpError,
  SignatureRequestApi,
  SubMergeField,
  TemplateApi,
  type SignatureRequestSendWithTemplateRequest,
} from "@dropbox/sign";

import { ProviderError } from "@/lib/errors/classes";

import type {
  DropboxSignProvider,
  CreateEmbeddedTemplateDraftInput,
  SendWithTemplateInput,
  SendWithTemplateOutput,
  ProviderTemplateMetadata,
  TemplatePdf,
} from "./contracts";
import { EsignSecret } from "./secret";

type DropboxApiSet = {
  account: AccountApi;
  apiApp: ApiAppApi;
  embedded: EmbeddedApi;
  signatureRequest: SignatureRequestApi;
  template: TemplateApi;
};

function authenticatedApiSet(apiKey: EsignSecret): DropboxApiSet {
  const account = new AccountApi();
  const apiApp = new ApiAppApi();
  const embedded = new EmbeddedApi();
  const signatureRequest = new SignatureRequestApi();
  const template = new TemplateApi();
  for (const api of [account, apiApp, embedded, signatureRequest, template]) {
    api.username = apiKey.reveal();
    api.password = "";
  }
  return { account, apiApp, embedded, signatureRequest, template };
}

function abortableSignatureApi(apiKey: EsignSecret, signal?: AbortSignal) {
  const signatureRequest = new SignatureRequestApi();
  signatureRequest.username = apiKey.reveal();
  signatureRequest.password = "";
  if (signal) {
    signatureRequest.addInterceptor((options) => {
      options.signal = signal;
    });
  }
  return signatureRequest;
}

export function createDropboxSignProvider(input: {
  apiKey: EsignSecret;
  clientId: string;
  expectedDomain: string;
}): DropboxSignProvider {
  const api = authenticatedApiSet(input.apiKey);

  return {
    async validateCredentials() {
      try {
        const [accountResponse, appResponse] = await Promise.all([
          api.account.accountGet(),
          api.apiApp.apiAppGet(input.clientId),
        ]);
        const apiApp = appResponse.body.apiApp;
        if (apiApp.clientId !== input.clientId) {
          throw new ProviderError(
            "Dropbox Sign returned a different API app client ID.",
            "dropbox_sign",
            { providerCode: "client_id_mismatch" },
          );
        }
        const domains = apiApp.domains ?? [];
        const expectedHost = normalizedDomain(input.expectedDomain);
        if (!domains.some((domain) => normalizedDomain(domain) === expectedHost)) {
          throw new ProviderError(
            "The Dropbox Sign API app does not allow Sandra's embedded domain.",
            "dropbox_sign",
            { providerCode: "embedded_domain_not_allowed" },
          );
        }
        return {
          accountId: accountResponse.body.account.accountId ?? null,
          clientId: apiApp.clientId,
          domains,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async createEmbeddedTemplateDraft(
      request: CreateEmbeddedTemplateDraftInput,
    ) {
      try {
        const response = await api.template.templateCreateEmbeddedDraft({
          clientId: input.clientId,
          files: [providerFile(request.file)],
          title: request.title,
          signerRoles: request.signerRoles.map((role) => ({ ...role })),
          forceSignerRoles: true,
          mergeFields: request.mergeFieldNames.map((name) => ({
            name,
            type: SubMergeField.TypeEnum.Text,
          })),
          metadata: { sandra_template_id: request.localTemplateId },
          testMode: true,
        });
        const template = response.body.template;
        if (!template.templateId || !template.editUrl) {
          throw new ProviderError(
            "Dropbox Sign did not return an embedded template draft session.",
            "dropbox_sign",
          );
        }
        return {
          providerTemplateId: template.templateId,
          editUrl: template.editUrl,
          expiresAt: template.expiresAt ?? null,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async getEmbeddedTemplateEditUrl(providerTemplateId: string) {
      try {
        const response = await api.embedded.embeddedEditUrl(providerTemplateId, {
          forceSignerRoles: true,
          testMode: true,
        });
        const embedded = response.body.embedded;
        if (!embedded.editUrl) {
          throw new ProviderError(
            "Dropbox Sign did not return an embedded template edit URL.",
            "dropbox_sign",
          );
        }
        return {
          providerTemplateId,
          editUrl: embedded.editUrl,
          expiresAt: embedded.expiresAt ?? null,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async getTemplate(providerTemplateId: string): Promise<ProviderTemplateMetadata> {
      try {
        const response = await api.template.templateGet(providerTemplateId);
        const template = response.body.template;
        return {
          providerTemplateId: template.templateId ?? providerTemplateId,
          title: template.title ?? null,
          signerRoles: (template.signerRoles ?? [])
            .map((role, index) => ({
              name: role.name ?? "",
              order: role.order ?? index,
            }))
            .sort((a, b) => a.order - b.order),
          mergeFieldNames: (template.namedFormFields ?? [])
            .map((field) => field.name)
            .filter((name): name is string => Boolean(name)),
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async getTemplateFiles(providerTemplateId: string) {
      try {
        return (await api.template.templateFiles(providerTemplateId, "pdf")).body;
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async duplicateTemplate(providerTemplateId: string, file: TemplatePdf) {
      try {
        const response = await api.template.templateUpdateFiles(providerTemplateId, {
          clientId: input.clientId,
          files: [providerFile(file)],
          testMode: true,
        });
        const duplicateId = response.body.template?.templateId;
        if (!duplicateId || duplicateId === providerTemplateId) {
          throw new ProviderError(
            "Dropbox Sign did not return a distinct copied template identifier.",
            "dropbox_sign",
            { providerCode: "template_copy_id_missing" },
          );
        }
        return { providerTemplateId: duplicateId, readiness: "pending" };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async updateTemplateFiles(providerTemplateId: string, file: TemplatePdf) {
      try {
        await api.template.templateUpdateFiles(providerTemplateId, {
          clientId: input.clientId,
          files: [providerFile(file)],
          testMode: true,
        });
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async deleteTemplate(providerTemplateId: string) {
      try {
        await api.template.templateDelete(providerTemplateId);
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async sendWithTemplate(
      request: SendWithTemplateInput,
    ): Promise<SendWithTemplateOutput> {
      const body: SignatureRequestSendWithTemplateRequest = {
        templateIds: [request.templateId],
        clientId: input.clientId,
        signers: request.signers,
        customFields: Object.entries(request.mergeValues).map(([name, value]) => ({
          name,
          value,
        })),
        metadata: { sandra_request_id: request.localRequestId },
        title: request.title,
        subject: request.subject,
        message: request.message,
        testMode: true,
      };
      try {
        const response =
          await abortableSignatureApi(input.apiKey, request.signal)
            .signatureRequestSendWithTemplate(body);
        const signatureRequest = response.body.signatureRequest;
        if (!signatureRequest.signatureRequestId) {
          throw new ProviderError(
            "Dropbox Sign did not return a signature request identifier.",
            "dropbox_sign",
          );
        }
        return {
          signatureRequestId: signatureRequest.signatureRequestId,
          signatures: (signatureRequest.signatures ?? []).flatMap(
            (signature, index) =>
              signature.signatureId &&
              signature.signerRole &&
              signature.signerName &&
              signature.signerEmailAddress
                ? [{
                    signatureId: signature.signatureId,
                    role: signature.signerRole,
                    name: signature.signerName,
                    emailAddress: signature.signerEmailAddress,
                    order: signature.order ?? index,
                  }]
                : [],
          ),
          detailsUrl: signatureRequest.detailsUrl ?? null,
          testMode: true,
        };
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async remind(
      signatureRequestId: string,
      signer: { emailAddress: string; name?: string },
      signal?: AbortSignal,
    ) {
      try {
        await abortableSignatureApi(input.apiKey, signal).signatureRequestRemind(signatureRequestId, {
          emailAddress: signer.emailAddress,
          name: signer.name,
        });
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async cancel(signatureRequestId: string, signal?: AbortSignal) {
      try {
        await abortableSignatureApi(input.apiKey, signal).signatureRequestCancel(signatureRequestId);
      } catch (error) {
        throw normalizeDropboxSignError(error);
      }
    },

    async downloadSignedPdf(signatureRequestId: string) {
      try {
        const response = await api.signatureRequest.signatureRequestFiles(
          signatureRequestId,
          "pdf",
        );
        return response.body;
      } catch (error) {
        throw normalizeDropboxSignError(error, { retryableStatuses: [409] });
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

function normalizedDomain(value: string): string {
  try {
    return new URL(
      value.includes("://") ? value : `https://${value}`,
    ).hostname.toLowerCase();
  } catch {
    return value.trim().toLowerCase().replace(/^https?:\/\//, "").split("/")[0];
  }
}

export function normalizeDropboxSignError(
  error: unknown,
  options: { retryableStatuses?: number[] } = {},
): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof HttpError) {
    const retryAfter = error.response?.headers?.["retry-after"];
    return new ProviderError(
      error.body?.error?.errorMsg || "Dropbox Sign rejected the request.",
      "dropbox_sign",
      {
        providerCode: error.body?.error?.errorName,
        statusCode: error.statusCode,
        retryAfterSeconds:
          typeof retryAfter === "string" ? Number(retryAfter) : undefined,
        retryable:
          error.statusCode === 429 ||
          (error.statusCode ?? 0) >= 500 ||
          options.retryableStatuses?.includes(error.statusCode ?? 0) === true,
      },
    );
  }
  return new ProviderError(
    error instanceof Error
      ? error.message
      : "Dropbox Sign request failed unexpectedly.",
    "dropbox_sign",
  );
}
