import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Resumable result cache: one JSON object per line, last write for a key wins. Errors are never cached. */
export interface CompareCache {
  get(key: string): unknown | undefined;
  set(key: string, value: unknown): void;
}

export class MemoryCache implements CompareCache {
  readonly map = new Map<string, unknown>();
  get(key: string) { return this.map.get(key); }
  set(key: string, value: unknown) { this.map.set(key, value); }
}

export class FileCache implements CompareCache {
  private readonly map = new Map<string, unknown>();
  constructor(private readonly file: string) {
    mkdirSync(path.dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { key: string; value: unknown };
          if (typeof rec.key === "string") this.map.set(rec.key, rec.value);
        } catch {
          // A torn last line from an interrupted run: ignore it, the call is simply redone.
        }
      }
    } else {
      writeFileSync(file, "", { mode: 0o600 });
    }
    try { chmodSync(file, 0o600); } catch { /* best effort */ }
  }
  get(key: string) { return this.map.get(key); }
  set(key: string, value: unknown) {
    this.map.set(key, value);
    appendFileSync(this.file, `${JSON.stringify({ key, value })}\n`);
  }
}
