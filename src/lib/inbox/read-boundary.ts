import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

const DOMAIN = "sandra:inbox:read-boundary:v1\0";
const MAX_TOKEN_BYTES = 2048;
const MAX_REVISION = BigInt("9223372036854775807");
/** Initial policy ceiling, not a measured or approved UX latency guarantee. */
export const MAX_READ_BOUNDARY_TTL_SECONDS = 300;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KID = /^[A-Za-z0-9_-]{1,64}$/;

export interface ReadBoundaryContext {
  requesterId: string;
  organizationId: string;
  conversationId: string;
  /** Proposed persisted UUID generation; the current SQL does not yet return it. */
  captureGeneration: string;
}
export interface ReadBoundarySnapshot extends ReadBoundaryContext {
  boundaryId: string;
  snapshotId: string;
  headRevision: string;
}
export interface ReadBoundaryEnvelope extends ReadBoundarySnapshot {
  version: 1;
  kid: string;
  /** Integer Unix seconds. */
  issuedAt: number;
  expiresAt: number;
}
export interface ReadBoundaryConfiguration {
  currentKid: string;
  /** Dedicated unpredictable keys; byte length alone does not establish entropy.
   * Retain previous keys only for the desired rotation window. */
  keys: ReadonlyMap<string, Uint8Array>;
  ttlSeconds: number;
  maxTtlSeconds: number;
}
export class InvalidReadBoundaryError extends Error {
  constructor() {
    super("Invalid Inbox read boundary");
    this.name = "InvalidReadBoundaryError";
  }
}
function requireValid(condition: unknown): asserts condition {
  if (!condition) throw new InvalidReadBoundaryError();
}
const FIELDS = ["version", "kid", "boundaryId", "requesterId", "organizationId", "conversationId", "captureGeneration", "headRevision", "snapshotId", "issuedAt", "expiresAt"];
const SNAPSHOT_FIELDS = FIELDS.filter((field) => !["version", "kid", "issuedAt", "expiresAt"].includes(field));
const CONTEXT_FIELDS = ["requesterId", "organizationId", "conversationId", "captureGeneration"];
function exactObject(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  requireValid(value !== null && typeof value === "object" && !Array.isArray(value));
  requireValid(Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)));
}
function validContext(value: ReadBoundaryContext) {
  for (const field of CONTEXT_FIELDS) {
    const id = value[field as keyof ReadBoundaryContext];
    requireValid(typeof id === "string" && UUID.test(id));
  }
}
function validSnapshot(value: ReadBoundarySnapshot) {
  validContext(value);
  requireValid(typeof value.boundaryId === "string" && UUID.test(value.boundaryId));
  requireValid(typeof value.snapshotId === "string" && UUID.test(value.snapshotId));
  requireValid(typeof value.headRevision === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value.headRevision));
  requireValid(BigInt(value.headRevision) <= MAX_REVISION);
}
function validTime(value: number) {
  requireValid(Number.isSafeInteger(value) && value >= 0);
}
/** Fixed field order also rejects duplicate JSON keys, whitespace and alternate encodings. */
function canonical(value: ReadBoundaryEnvelope) {
  return JSON.stringify({
    version: value.version, kid: value.kid, boundaryId: value.boundaryId,
    requesterId: value.requesterId, organizationId: value.organizationId,
    conversationId: value.conversationId, captureGeneration: value.captureGeneration,
    headRevision: value.headRevision, snapshotId: value.snapshotId,
    issuedAt: value.issuedAt, expiresAt: value.expiresAt,
  });
}
function decode(segment: string): Buffer {
  requireValid(/^[A-Za-z0-9_-]+$/.test(segment));
  const bytes = Buffer.from(segment, "base64url");
  requireValid(bytes.toString("base64url") === segment);
  return bytes;
}

/**
 * Integrity primitive only: signed payloads are readable, replayable and not authorization.
 * Issue only from an authorized committed DB snapshot. Verify against server-resolved
 * context, then recheck live DB access/capture generation and persist idempotent receipts.
 * Current SQL does not install/return authoritative capture-generation metadata.
 * This module cannot turn that SQL result alone into an authoritative boundary.
 * Future-issued tokens are rejected with zero clock tolerance; distributed clock
 * policy must be assessed separately before deployment.
 * No environment reads, route activation or default key material occurs here.
 */
export function createReadBoundaryCodec(configuration: ReadBoundaryConfiguration) {
  requireValid(typeof configuration.currentKid === "string" && KID.test(configuration.currentKid));
  requireValid(Number.isSafeInteger(configuration.maxTtlSeconds) && configuration.maxTtlSeconds > 0 && configuration.maxTtlSeconds <= MAX_READ_BOUNDARY_TTL_SECONDS);
  requireValid(Number.isSafeInteger(configuration.ttlSeconds) && configuration.ttlSeconds > 0 && configuration.ttlSeconds <= configuration.maxTtlSeconds);
  const keys = new Map<string, Buffer>();
  requireValid(configuration.keys instanceof Map && configuration.keys.size > 0 && configuration.keys.size <= 16);
  for (const [kid, key] of configuration.keys) {
    requireValid(typeof kid === "string" && KID.test(kid) && key instanceof Uint8Array && key.byteLength >= 32 && key.byteLength <= 1024);
    keys.set(kid, Buffer.from(key));
  }
  requireValid(keys.has(configuration.currentKid));
  const { currentKid, ttlSeconds, maxTtlSeconds } = configuration;
  function mac(payload: string, key: Buffer) {
    return createHmac("sha256", key).update(DOMAIN, "utf8").update(payload, "ascii").digest();
  }
  return {
    issue(snapshot: ReadBoundarySnapshot, nowSeconds: number): string {
      exactObject(snapshot, SNAPSHOT_FIELDS);
      validSnapshot(snapshot);
      validTime(nowSeconds);
      validTime(nowSeconds + ttlSeconds);
      const envelope: ReadBoundaryEnvelope = { ...snapshot, version: 1, kid: currentKid, issuedAt: nowSeconds, expiresAt: nowSeconds + ttlSeconds };
      const payload = Buffer.from(canonical(envelope), "utf8").toString("base64url");
      return `${payload}.${mac(payload, keys.get(currentKid)!).toString("base64url")}`;
    },
    verify(token: string, expected: ReadBoundaryContext, nowSeconds: number): Readonly<ReadBoundaryEnvelope> {
      try {
        exactObject(expected, CONTEXT_FIELDS);
        validContext(expected);
        validTime(nowSeconds);
        requireValid(typeof token === "string" && token.length <= MAX_TOKEN_BYTES);
        const segments = token.split(".");
        requireValid(segments.length === 2);
        const payloadBytes = decode(segments[0]);
        const signature = decode(segments[1]);
        requireValid(signature.length === 32);
        const value: unknown = JSON.parse(payloadBytes.toString("utf8"));
        exactObject(value, FIELDS);
        requireValid(value.version === 1 && typeof value.kid === "string" && KID.test(value.kid));
        const key = keys.get(value.kid as string);
        requireValid(key && timingSafeEqual(signature, mac(segments[0], key)));
        const envelope = value as unknown as ReadBoundaryEnvelope;
        validSnapshot(envelope);
        validTime(envelope.issuedAt);
        validTime(envelope.expiresAt);
        requireValid(envelope.issuedAt <= nowSeconds && envelope.expiresAt > nowSeconds);
        requireValid(envelope.expiresAt > envelope.issuedAt && envelope.expiresAt - envelope.issuedAt <= maxTtlSeconds);
        requireValid(Buffer.from(canonical(envelope), "utf8").equals(payloadBytes));
        for (const field of CONTEXT_FIELDS) requireValid(envelope[field as keyof ReadBoundaryContext] === expected[field as keyof ReadBoundaryContext]);
        return Object.freeze(envelope);
      } catch {
        throw new InvalidReadBoundaryError();
      }
    },
  };
}
