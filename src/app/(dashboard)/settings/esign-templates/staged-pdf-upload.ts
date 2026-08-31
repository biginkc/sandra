"use client";

import * as tus from "tus-js-client";

export const STANDARD_UPLOAD_MAX_BYTES = 6 * 1024 * 1024;
export const STAGED_PDF_MAX_BYTES = 40 * 1024 * 1024;

type BrowserStorageClient = Readonly<{
  auth: {
    getSession(): Promise<{ data: { session: { access_token: string } | null }; error: unknown }>;
  };
  storage: {
    from(bucket: string): {
      upload(path: string, file: File, options: { contentType: string; upsert: false }): Promise<{ error: unknown }>;
    };
  };
}>;

export type StagedUploadResult = Readonly<{
  method: "standard" | "resumable";
  bucket: string;
  storagePath: string;
}>;

export class AmbiguousTusTerminationError extends Error {
  override name = "AmbiguousTusTerminationError";
}

export function reservationFingerprint(bucket: string, storagePath: string) {
  return (sha256: string) => async (file: File): Promise<string> => JSON.stringify([
    "sandra-esign-staged-pdf-v1",
    bucket,
    storagePath,
    file.name,
    file.type,
    file.size,
    file.lastModified,
    sha256,
  ]);
}

export async function uploadStagedPdf(
  client: BrowserStorageClient,
  reservation: Readonly<{ bucket: "esign-staging"; storagePath: string }>,
  file: File,
  sha256: string,
  signal?: AbortSignal,
): Promise<StagedUploadResult> {
  if (file.size <= 0 || file.size > STAGED_PDF_MAX_BYTES) throw new Error("Private PDF upload size is invalid");
  if (file.size <= STANDARD_UPLOAD_MAX_BYTES) {
    throwIfAborted(signal);
    const { error } = await client.storage.from(reservation.bucket).upload(reservation.storagePath, file, {
      contentType: "application/pdf",
      upsert: false,
    });
    // Supabase's standard upload cannot be interrupted. Fence its late result so a
    // closed dialog can never advance into draft/provider creation.
    throwIfAborted(signal);
    if (error) throw new Error("Private PDF upload failed");
    return { method: "standard", ...reservation };
  }

  const endpoint = directStorageTusEndpoint(requiredSupabaseUrl());
  await new Promise<void>((resolve, reject) => {
    let state: "active" | "terminating" | "settled" = "active";
    const upload = new tus.Upload(file, {
      endpoint,
      retryDelays: [0, 3_000, 5_000, 10_000, 20_000],
      chunkSize: STANDARD_UPLOAD_MAX_BYTES,
      onBeforeRequest: async (request) => {
        const { data, error } = await client.auth.getSession();
        const accessToken = data.session?.access_token;
        if (error || !accessToken) throw new Error("Authenticated upload session unavailable");
        request.setHeader("authorization", `Bearer ${accessToken}`);
      },
      metadata: {
        bucketName: reservation.bucket,
        objectName: reservation.storagePath,
        contentType: "application/pdf",
        cacheControl: "3600",
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      fingerprint: reservationFingerprint(reservation.bucket, reservation.storagePath)(sha256),
      onError: () => settleReject(new Error("Resumable private PDF upload failed")),
      onSuccess: () => settleResolve(),
    });

    const removeAbortListener = () => signal?.removeEventListener("abort", abort);
    const settleResolve = () => {
      if (state !== "active") return;
      state = "settled";
      removeAbortListener();
      resolve();
    };
    const settleReject = (error: Error) => {
      if (state !== "active") return;
      state = "settled";
      removeAbortListener();
      reject(error);
    };
    const finishTermination = (error: Error) => {
      if (state !== "terminating") return;
      state = "settled";
      removeAbortListener();
      reject(error);
    };
    const abort = () => {
      if (state !== "active") return;
      state = "terminating";
      void upload.abort(true).then(
        () => finishTermination(new DOMException("Upload aborted", "AbortError")),
        () => finishTermination(new AmbiguousTusTerminationError("Resumable upload termination could not be confirmed")),
      );
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });

    void upload.findPreviousUploads()
      .then((previous) => {
        if (state !== "active") return;
        if (previous[0]) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch(() => {
        settleReject(new Error("Resumable private PDF upload could not start"));
      });
  });

  return { method: "resumable", ...reservation };
}

export function directStorageTusEndpoint(supabaseUrl: string): string {
  const url = new URL(supabaseUrl);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (loopback) {
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.port) throw new Error("Local Supabase URL is invalid");
    return `${url.origin}/storage/v1/upload/resumable`;
  }
  const match = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
  const project = match?.[1];
  if (url.protocol !== "https:" || !project) throw new Error("Supabase project URL is invalid");
  return `https://${project}.storage.supabase.co/storage/v1/upload/resumable`;
}

function requiredSupabaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!value) throw new Error("Supabase project URL is unavailable");
  return value;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
}
