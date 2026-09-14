import type { BrowserCaptureChunk, BrowserCaptureEvent } from "./reliability-browser-capture";
import type { ReliabilityTimingMarker } from "./reliability-timing";
import type { CallTarget } from "./transport";

export const RELIABILITY_CAPTURE_CONFIG_KEY = "sandra:reliability-capture:v1";
export const RELIABILITY_CAPTURE_DB_NAME = "sandra-reliability-capture-v2";
const RELIABILITY_CAPTURE_DB_VERSION = 3;
const MAX_CONFIG_LIFETIME_MS = 2 * 60 * 60 * 1_000;

export type ReliabilityCaptureConfig = {
  readonly runId: string;
  readonly destinationE164: string;
  readonly callerIdE164: string;
  readonly expiresAtEpochMs: number;
};

const isE164 = (value: unknown): value is string =>
  typeof value === "string" && /^\+[1-9]\d{7,14}$/.test(value);

export function parseReliabilityCaptureConfig(
  raw: string | null,
  target: CallTarget,
  nowEpochMs: number,
): ReliabilityCaptureConfig | null {
  if (!raw) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.runId !== "string" ||
    !/^[a-zA-Z0-9_-]{8,80}$/.test(candidate.runId) ||
    !isE164(candidate.destinationE164) ||
    !isE164(candidate.callerIdE164) ||
    !Number.isSafeInteger(candidate.expiresAtEpochMs) ||
    (candidate.expiresAtEpochMs as number) <= nowEpochMs ||
    (candidate.expiresAtEpochMs as number) > nowEpochMs + MAX_CONFIG_LIFETIME_MS ||
    candidate.destinationE164 !== target.phoneE164 ||
    candidate.callerIdE164 !== target.callerIdE164
  ) return null;
  return candidate as ReliabilityCaptureConfig;
}

type CaptureStoreRecord = {
  readonly runId: string;
  readonly callId: string;
  readonly segment: number;
  readonly atMonotonicMs: number;
  readonly atEpochMs: number;
};

export type CaptureStore = {
  writeChunk(chunk: BrowserCaptureChunk): Promise<void>;
  writeEvent(event: BrowserCaptureEvent): Promise<void>;
  writeTiming(marker: ReliabilityTimingMarker): Promise<void>;
  close(): void;
};

export type StoredCaptureChunk = CaptureStoreRecord & {
  readonly sequence: number;
  readonly mimeType: string;
  readonly blob: Blob;
};

export type StoredCaptureEvent = CaptureStoreRecord & {
  readonly kind: BrowserCaptureEvent["kind"];
  readonly detail?: string;
};

export type StoredReliabilityTiming = CaptureStoreRecord & ReliabilityTimingMarker;

function openDatabase(databaseFactory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = databaseFactory.open(RELIABILITY_CAPTURE_DB_NAME, RELIABILITY_CAPTURE_DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("chunks"))
        database.createObjectStore("chunks", { keyPath: ["runId", "callId", "segment", "sequence"] });
      const events = database.objectStoreNames.contains("events")
        ? request.transaction!.objectStore("events")
        : database.createObjectStore("events", { autoIncrement: true });
      if (!events.indexNames.contains("byCall")) events.createIndex("byCall", ["runId", "callId"]);
      if (!database.objectStoreNames.contains("timings"))
        database.createObjectStore("timings", { keyPath: ["runId", "callId", "sequence"] });
    };
    request.onblocked = () => reject(new Error("Capture database upgrade blocked"));
    request.onerror = () => reject(request.error ?? new Error("Capture database open failed"));
    request.onsuccess = () => resolve(request.result);
  });
}

export function openReliabilityCaptureStore(
  runId: string,
  callId: string,
  segment: number,
  databaseFactory: IDBFactory = indexedDB,
  nowEpochMs: () => number = () => Date.now(),
): Promise<CaptureStore> {
  return openDatabase(databaseFactory).then((database) => {
      const write = (storeName: "chunks" | "events" | "timings", value: Record<string, unknown>) =>
        new Promise<void>((done, fail) => {
          let transaction: IDBTransaction;
          try { transaction = database.transaction(storeName, "readwrite"); }
          catch (error) { fail(error); return; }
          transaction.objectStore(storeName).put(value);
          transaction.oncomplete = () => done();
          transaction.onerror = () => fail(transaction.error ?? new Error("Capture write failed"));
          transaction.onabort = () => fail(transaction.error ?? new Error("Capture write aborted"));
        });
      const base = (atMonotonicMs: number): CaptureStoreRecord => ({
        runId, callId, segment, atMonotonicMs, atEpochMs: nowEpochMs(),
      });
      return {
        writeChunk: (chunk) => write("chunks", {
          ...base(chunk.atMonotonicMs), sequence: chunk.sequence,
          mimeType: chunk.blob.type, blob: chunk.blob,
        }),
        writeEvent: (event) => write("events", {
          ...base(event.atMonotonicMs), kind: event.kind,
          ...(event.detail ? { detail: event.detail } : {}),
        }),
        writeTiming: (marker) => write("timings", {
          ...base(marker.atMonotonicMs), sequence: marker.sequence,
          stage: marker.stage, atEpochMs: marker.atEpochMs,
          clockUncertaintyMs: marker.clockUncertaintyMs,
          ...(marker.detail ? { detail: marker.detail } : {}),
        }),
        close: () => database.close(),
      };
  });
}

export async function readReliabilityCapture(
  runId: string,
  callId: string,
  databaseFactory: IDBFactory = indexedDB,
): Promise<{
  readonly chunks: readonly StoredCaptureChunk[];
  readonly events: readonly StoredCaptureEvent[];
  readonly timings: readonly StoredReliabilityTiming[];
}> {
  const database = await openDatabase(databaseFactory);
    const read = <T>(storeName: "chunks" | "events" | "timings", range: IDBKeyRange, indexName?: string) =>
    new Promise<T[]>((resolve, reject) => {
      const transaction = database.transaction(storeName, "readonly");
      const store = transaction.objectStore(storeName);
      const request = (indexName ? store.index(indexName) : store).getAll(range);
      request.onsuccess = () => resolve(request.result as T[]);
      request.onerror = () => reject(request.error ?? new Error("Capture read failed"));
    });
  try {
    const [chunks, events, timings] = await Promise.all([
      read<StoredCaptureChunk>("chunks", IDBKeyRange.bound(
        [runId, callId, 0, 0], [runId, callId, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
      )),
      read<StoredCaptureEvent>("events", IDBKeyRange.only([runId, callId]), "byCall"),
      read<StoredReliabilityTiming>("timings", IDBKeyRange.bound(
        [runId, callId, 0], [runId, callId, Number.MAX_SAFE_INTEGER],
      )),
    ]);
    return { chunks, events, timings };
  } finally {
    database.close();
  }
}
