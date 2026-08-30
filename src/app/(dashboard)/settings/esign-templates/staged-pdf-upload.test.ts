import { beforeEach, describe, expect, it, vi } from "vitest";

const tusState = vi.hoisted(() => ({
  options: null as Record<string, unknown> | null,
  optionsHistory: [] as Record<string, unknown>[],
  start: vi.fn(),
  abort: vi.fn().mockResolvedValue(undefined),
  findPreviousUploads: vi.fn().mockResolvedValue([]),
}));

vi.mock("tus-js-client", () => ({
  Upload: class {
    constructor(_file: File, options: Record<string, unknown>) { tusState.options = options; tusState.optionsHistory.push(options); }
    start = tusState.start;
    abort = tusState.abort;
    findPreviousUploads = tusState.findPreviousUploads;
    resumeFromPreviousUpload = vi.fn();
  },
}));

import {
  directStorageTusEndpoint,
  AmbiguousTusTerminationError,
  reservationFingerprint,
  STAGED_PDF_MAX_BYTES,
  STANDARD_UPLOAD_MAX_BYTES,
  uploadStagedPdf,
} from "./staged-pdf-upload";

const reservation = { bucket: "esign-staging" as const, storagePath: "org-1/source-1.pdf" };
const SHA = "a".repeat(64);

function client() {
  return {
    auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: "private-jwt" } }, error: null }) },
    storage: { from: vi.fn(() => ({ upload: vi.fn().mockResolvedValue({ error: null }) })) },
  };
}

function sizedPdf(size: number): File {
  const file = new File(["%PDF-"], "offer.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("staged PDF browser transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tusState.options = null;
    tusState.optionsHistory = [];
    tusState.findPreviousUploads.mockResolvedValue([]);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project-ref.supabase.co");
  });

  it("uses create-only standard upload through exactly 6 MiB", async () => {
    const supabase = client();
    await expect(uploadStagedPdf(supabase, reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES), SHA)).resolves.toMatchObject({ method: "standard" });
    expect(supabase.storage.from).toHaveBeenCalledWith("esign-staging");
    const upload = supabase.storage.from.mock.results[0]?.value.upload;
    expect(upload).toHaveBeenCalledWith(reservation.storagePath, expect.any(File), { contentType: "application/pdf", upsert: false });
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
  });

  it("rejects a pre-aborted standard upload before touching Storage", async () => {
    const supabase = client();
    const controller = new AbortController();
    controller.abort();
    await expect(uploadStagedPdf(
      supabase,
      reservation,
      sizedPdf(STANDARD_UPLOAD_MAX_BYTES),
      SHA,
      controller.signal,
    )).rejects.toMatchObject({ name: "AbortError" });
    expect(supabase.storage.from).not.toHaveBeenCalled();
  });

  it("rejects a late successful standard upload after cancellation", async () => {
    let finishUpload!: (value: { error: null }) => void;
    const upload = vi.fn().mockReturnValue(new Promise((resolve) => { finishUpload = resolve; }));
    const supabase = client();
    supabase.storage.from.mockReturnValue({ upload });
    const controller = new AbortController();
    const pending = uploadStagedPdf(supabase, reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES), SHA, controller.signal);
    await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
    controller.abort();
    finishUpload({ error: null });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses authenticated create-only TUS above 6 MiB with the direct Storage endpoint", async () => {
    const supabase = client();
    const pending = uploadStagedPdf(supabase, reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1), SHA);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledOnce());
    const options = tusState.options as {
      endpoint: string; metadata: Record<string, string>;
      removeFingerprintOnSuccess: boolean; uploadDataDuringCreation: boolean; onSuccess(): void;
    };
    expect(options.endpoint).toBe("https://project-ref.storage.supabase.co/storage/v1/upload/resumable");
    expect(options).not.toHaveProperty("headers");
    expect(options.metadata).toMatchObject({ bucketName: "esign-staging", objectName: reservation.storagePath, contentType: "application/pdf" });
    expect(options.removeFingerprintOnSuccess).toBe(true);
    expect(options.uploadDataDuringCreation).toBe(true);
    options.onSuccess();
    await expect(pending).resolves.toEqual({ method: "resumable", ...reservation });
  });

  it("binds resumable fingerprints to the exact reservation path for the same File", async () => {
    const file = sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1);
    const first = await reservationFingerprint("esign-staging", "org-1/source-1.pdf")(SHA)(file);
    const same = await reservationFingerprint("esign-staging", "org-1/source-1.pdf")(SHA)(file);
    const second = await reservationFingerprint("esign-staging", "org-1/source-2.pdf")(SHA)(file);
    expect(first).toBe(same);
    expect(first).not.toBe(second);
    const differentBytes = await reservationFingerprint("esign-staging", "org-1/source-1.pdf")("b".repeat(64))(file);
    expect(first).not.toBe(differentBytes);
    expect(first).toContain("sandra-esign-staged-pdf-v1");

    const firstPending = uploadStagedPdf(client(), reservation, file, SHA);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledTimes(1));
    (tusState.optionsHistory[0] as { onSuccess(): void }).onSuccess();
    await firstPending;
    const secondPending = uploadStagedPdf(client(), { ...reservation, storagePath: "org-1/source-2.pdf" }, file, SHA);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledTimes(2));
    const configuredFirst = await (tusState.optionsHistory[0] as { fingerprint(file: File): Promise<string> }).fingerprint(file);
    const configuredSecond = await (tusState.optionsHistory[1] as { fingerprint(file: File): Promise<string> }).fingerprint(file);
    expect(configuredFirst).not.toBe(configuredSecond);
    (tusState.optionsHistory[1] as { onSuccess(): void }).onSuccess();
    await secondPending;
  });

  it("accepts exactly 40 MiB and rejects one byte over before either transport", async () => {
    const exactClient = client();
    const exact = uploadStagedPdf(exactClient, reservation, sizedPdf(STAGED_PDF_MAX_BYTES), SHA);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledOnce());
    (tusState.options as { onSuccess(): void }).onSuccess();
    await expect(exact).resolves.toMatchObject({ method: "resumable" });

    const overClient = client();
    await expect(uploadStagedPdf(overClient, reservation, sizedPdf(STAGED_PDF_MAX_BYTES + 1), SHA)).rejects.toThrow("size is invalid");
    expect(overClient.auth.getSession).not.toHaveBeenCalled();
    expect(overClient.storage.from).not.toHaveBeenCalled();
  });

  it("aborts without exposing the token and leaves the caller to invoke durable cleanup", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const controller = new AbortController();
    const pending = uploadStagedPdf(client(), reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1), SHA, controller.signal);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(tusState.abort).toHaveBeenCalledWith(true);
    expect(consoleError).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });

  it("waits for remote TUS termination before exposing an abort to cleanup", async () => {
    let finishAbort!: () => void;
    tusState.abort.mockReturnValueOnce(new Promise<void>((resolve) => { finishAbort = resolve; }));
    const controller = new AbortController();
    const pending = uploadStagedPdf(client(), reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1), SHA, controller.signal);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledOnce());
    controller.abort();
    let settled = false;
    void pending.finally(() => { settled = true; }).catch(() => undefined);
    await Promise.resolve();
    expect(settled).toBe(false);
    finishAbort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("ignores a late success while termination is pending and lets only termination decide", async () => {
    let finishAbort!: () => void;
    tusState.abort.mockReturnValueOnce(new Promise<void>((resolve) => { finishAbort = resolve; }));
    const controller = new AbortController();
    const pending = uploadStagedPdf(client(), reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1), SHA, controller.signal);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledOnce());
    controller.abort();
    (tusState.options as { onSuccess(): void }).onSuccess();

    let resolved = false;
    void pending.then(() => { resolved = true; }, () => undefined);
    await Promise.resolve();
    expect(resolved).toBe(false);
    finishAbort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("never starts after a pre-start abort while previous-upload discovery is unresolved", async () => {
    let finishDiscovery!: (uploads: []) => void;
    tusState.findPreviousUploads.mockReturnValueOnce(new Promise<[]>((resolve) => { finishDiscovery = resolve; }));
    let finishAbort!: () => void;
    tusState.abort.mockReturnValueOnce(new Promise<void>((resolve) => { finishAbort = resolve; }));
    const controller = new AbortController();
    const pending = uploadStagedPdf(client(), reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1), SHA, controller.signal);
    await vi.waitFor(() => expect(tusState.findPreviousUploads).toHaveBeenCalledOnce());
    controller.abort();
    finishDiscovery([]);
    await Promise.resolve();
    expect(tusState.start).not.toHaveBeenCalled();
    finishAbort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("surfaces failed TUS termination as ambiguous and removes the AbortSignal listener", async () => {
    tusState.abort.mockRejectedValueOnce(new Error("termination response lost"));
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const pending = uploadStagedPdf(client(), reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1), SHA, controller.signal);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AmbiguousTusTerminationError);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("removes the AbortSignal listener on success and upload error", async () => {
    const successController = new AbortController();
    const successRemove = vi.spyOn(successController.signal, "removeEventListener");
    const success = uploadStagedPdf(client(), reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1), SHA, successController.signal);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledOnce());
    (tusState.options as { onSuccess(): void }).onSuccess();
    await success;
    expect(successRemove).toHaveBeenCalledWith("abort", expect.any(Function));

    vi.clearAllMocks();
    const errorController = new AbortController();
    const errorRemove = vi.spyOn(errorController.signal, "removeEventListener");
    const failed = uploadStagedPdf(client(), reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1), SHA, errorController.signal);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledOnce());
    (tusState.options as { onError(): void }).onError();
    await expect(failed).rejects.toThrow("upload failed");
    expect(errorRemove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("derives only the official direct hostname and rejects non-project URLs", () => {
    expect(directStorageTusEndpoint("https://abc123.supabase.co")).toBe("https://abc123.storage.supabase.co/storage/v1/upload/resumable");
    expect(directStorageTusEndpoint("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321/storage/v1/upload/resumable");
    expect(directStorageTusEndpoint("http://localhost:54321")).toBe("http://localhost:54321/storage/v1/upload/resumable");
    expect(directStorageTusEndpoint("http://[::1]:54321")).toBe("http://[::1]:54321/storage/v1/upload/resumable");
    expect(() => directStorageTusEndpoint("http://localhost")).toThrow("Local Supabase URL is invalid");
    expect(() => directStorageTusEndpoint("https://example.com")).toThrow("invalid");
  });

  it("refreshes authorization before every TUS request and supports token rotation", async () => {
    const supabase = client();
    supabase.auth.getSession
      .mockResolvedValueOnce({ data: { session: { access_token: "token-one" } }, error: null })
      .mockResolvedValueOnce({ data: { session: { access_token: "token-two" } }, error: null });
    const pending = uploadStagedPdf(supabase, reservation, sizedPdf(STANDARD_UPLOAD_MAX_BYTES + 1), SHA);
    await vi.waitFor(() => expect(tusState.start).toHaveBeenCalledOnce());
    const beforeRequest = (tusState.options as { onBeforeRequest(request: { setHeader(name: string, value: string): void }): Promise<void> }).onBeforeRequest;
    const first = { setHeader: vi.fn() };
    const second = { setHeader: vi.fn() };
    await beforeRequest(first);
    await beforeRequest(second);
    expect(first.setHeader).toHaveBeenCalledWith("authorization", "Bearer token-one");
    expect(second.setHeader).toHaveBeenCalledWith("authorization", "Bearer token-two");
    (tusState.options as { onSuccess(): void }).onSuccess();
    await pending;
  });
});
