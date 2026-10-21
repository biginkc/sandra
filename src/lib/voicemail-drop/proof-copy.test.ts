import { describe, expect, it, vi } from "vitest";

import {
  copyDropProof,
  downloadProof,
  PROOF_MAX_ATTEMPTS,
  type ProofCopyStore,
  type ProofDrop,
  sweepPendingProofCopies,
} from "./proof-copy";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const DROP = "00000000-0000-4000-8000-0000000000d1";
const NOW = new Date("2026-10-21T12:00:00Z");

function fakeStore(initial: Partial<ProofDrop> = {}) {
  const drop: ProofDrop & Record<string, unknown> = {
    id: DROP, org_id: ORG, proof_url: "https://proof.example/r/tok", proof_url_at: null,
    completed_at: "2026-10-21T11:00:00Z", proof_storage_path: null, proof_copy_status: null, proof_copy_attempts: 0,
    ...initial,
  };
  const uploads: Array<{ path: string; size: number; contentType: string }> = [];
  const faults = { upload: 0 };
  const store: ProofCopyStore = {
    async getDrop(id) { return id === drop.id ? { ...drop } : null; },
    async markReceived(_id, at) { drop.proof_url_at = at; },
    async markStored(_id, facts) { if (!drop.proof_storage_path) Object.assign(drop, facts, { proof_copy_status: "stored" }); },
    async markPending(_id, attempts, nextAt, error) {
      Object.assign(drop, { proof_copy_status: "pending", proof_copy_attempts: attempts, proof_copy_next_at: nextAt, proof_copy_error: error });
    },
    async markFailed(_id, attempts, error) {
      Object.assign(drop, { proof_copy_status: "failed", proof_copy_attempts: attempts, proof_copy_error: error });
    },
    async upload(path, bytes, contentType) {
      if (faults.upload-- > 0) throw new Error("storage down");
      uploads.push({ path, size: bytes.byteLength, contentType });
    },
    async listDue() { return drop.proof_copy_status === "pending" ? [drop.id] : []; },
  };
  return { store, drop, uploads, faults };
}

const audio = (bytes = 1000, type = "audio/mpeg") => vi.fn(async () =>
  new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": type } }));

describe("copyDropProof", () => {
  it("downloads, stores under <org>/<drop>.<ext> and records the facts", async () => {
    const { store, drop, uploads } = fakeStore();
    const fetcher = audio(1234, "audio/mpeg; charset=binary");
    expect(await copyDropProof(store, DROP, { fetcher, now: NOW, receivedAt: NOW })).toBe("stored");
    expect(fetcher).toHaveBeenCalledWith("https://proof.example/r/tok", expect.objectContaining({ redirect: "follow" }));
    expect(uploads).toEqual([{ path: `${ORG}/${DROP}.mp3`, size: 1234, contentType: "audio/mpeg" }]);
    expect(drop).toMatchObject({
      proof_storage_path: `${ORG}/${DROP}.mp3`, proof_content_type: "audio/mpeg", proof_size_bytes: 1234,
      proof_fetched_at: NOW.toISOString(), proof_copy_status: "stored", proof_url_at: NOW.toISOString(),
    });
  });

  it("is idempotent: a replay never downloads again", async () => {
    const { store, uploads } = fakeStore();
    const fetcher = audio();
    await copyDropProof(store, DROP, { fetcher, now: NOW });
    expect(await copyDropProof(store, DROP, { fetcher, now: NOW })).toBe("already_stored");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(uploads).toHaveLength(1);
  });

  it("keeps proof_url and marks the copy pending with a backoff when the download fails", async () => {
    const { store, drop } = fakeStore();
    const fetcher = vi.fn(async () => new Response("{}", { status: 404, headers: { "retry-after": "60" } }));
    expect(await copyDropProof(store, DROP, { fetcher, now: NOW })).toBe("pending");
    expect(drop).toMatchObject({
      proof_url: "https://proof.example/r/tok", proof_storage_path: null, proof_copy_status: "pending",
      proof_copy_attempts: 1, proof_copy_next_at: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    });
  });

  it("marks pending when the upload fails, then the sweep stores it", async () => {
    const { store, drop, faults } = fakeStore();
    faults.upload = 1;
    expect(await copyDropProof(store, DROP, { fetcher: audio(), now: NOW })).toBe("pending");
    expect(drop.proof_copy_error).toBe("storage down");
    const counts = await sweepPendingProofCopies(store, { fetcher: audio(), now: NOW });
    expect(counts.stored).toBe(1);
    expect(drop.proof_copy_status).toBe("stored");
  });

  it("marks failed once the provider link would expire or attempts run out", async () => {
    const expiring = fakeStore({ proof_url_at: new Date(NOW.getTime() - 7 * 86_400_000 + 60_000).toISOString() });
    const bad = vi.fn(async () => new Response("x", { status: 410 }));
    expect(await copyDropProof(expiring.store, DROP, { fetcher: bad, now: NOW })).toBe("failed");
    const tired = fakeStore({ proof_url_at: NOW.toISOString(), proof_copy_attempts: PROOF_MAX_ATTEMPTS - 1 });
    expect(await copyDropProof(tired.store, DROP, { fetcher: bad, now: NOW })).toBe("failed");
    expect(tired.drop.proof_url).toBe("https://proof.example/r/tok");
  });

  it("returns no_proof_url / not_found without fetching", async () => {
    const fetcher = audio();
    expect(await copyDropProof(fakeStore({ proof_url: null }).store, DROP, { fetcher })).toBe("no_proof_url");
    expect(await copyDropProof(fakeStore().store, "other", { fetcher })).toBe("not_found");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("downloadProof", () => {
  it("rejects non-https, non-audio, oversize and empty bodies", async () => {
    await expect(downloadProof("http://proof.example/x", audio())).rejects.toThrow(/https/);
    await expect(downloadProof("https://p/x", audio(10, "text/html"))).rejects.toThrow(/content type/);
    await expect(downloadProof("https://p/x", audio(2048), 1000, 1024)).rejects.toThrow(/too large/);
    const declared = vi.fn(async () => new Response(new Uint8Array(10), { headers: { "content-type": "audio/wav", "content-length": "999999" } }));
    await expect(downloadProof("https://p/x", declared, 1000, 1024)).rejects.toThrow(/too large/);
    await expect(downloadProof("https://p/x", audio(0))).rejects.toThrow(/empty/);
  });

  it("turns a timeout into a download error", async () => {
    const hang = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    }));
    await expect(downloadProof("https://p/x", hang, 20)).rejects.toThrow(/proof fetch failed: TimeoutError/);
  });

  it("maps wav to .wav", async () => {
    expect((await downloadProof("https://p/x", audio(5, "audio/x-wav"))).ext).toBe("wav");
  });
});
