 
// Append-only inventory of resources this harness created or discovered on the
// test connection/application. Records type + Telnyx ID only (no secrets).
import fs from "node:fs";
import path from "node:path";

export type ResourceType =
  | "credential_connection"
  | "call_control_application"
  | "outbound_voice_profile"
  | "telephony_credential"
  | "call_leg"
  | "recording";

export interface Entry {
  type: ResourceType;
  id: string;
  createdAt: string;
  deletedAt?: string;
}

type Op =
  | { op: "add"; type: ResourceType; id: string; at: string }
  | { op: "deleted"; id: string; at: string }
  | { op: "role"; key: string; value: string }
  | { op: "sip"; username: string };

export class Inventory {
  private entries = new Map<string, Entry>();
  private roles = new Map<string, string>();
  private sip = new Set<string>();
  private file?: string;

  constructor(private dir?: string) {
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, "inventory.jsonl");
      if (fs.existsSync(this.file)) {
        for (const line of fs.readFileSync(this.file, "utf8").split("\n").filter(Boolean)) {
          this.apply(JSON.parse(line) as Op);
        }
      }
    }
  }

  private apply(o: Op): void {
    if (o.op === "add") this.entries.set(o.id, { type: o.type, id: o.id, createdAt: o.at });
    else if (o.op === "deleted") {
      const e = this.entries.get(o.id);
      if (e) e.deletedAt = o.at;
    } else if (o.op === "role") this.roles.set(o.key, o.value);
    else this.sip.add(o.username);
  }

  private write(o: Op): void {
    this.apply(o);
    if (this.file) fs.appendFileSync(this.file, JSON.stringify(o) + "\n");
  }

  add(type: ResourceType, id: string): void {
    if (!id) throw new Error("inventory: empty id");
    if (this.entries.has(id)) return;
    this.write({ op: "add", type, id, at: new Date().toISOString() });
  }

  markDeleted(id: string): void {
    if (this.entries.has(id)) this.write({ op: "deleted", id, at: new Date().toISOString() });
  }

  /** True if the ID is inventoried (and, when given, of one of the types). */
  has(id: string, types?: ResourceType[]): boolean {
    const e = this.entries.get(id);
    return !!e && (!types || types.includes(e.type));
  }

  idsOf(type: ResourceType, opts: { includeDeleted?: boolean } = {}): string[] {
    return [...this.entries.values()]
      .filter((e) => e.type === type && (opts.includeDeleted || !e.deletedAt))
      .map((e) => e.id);
  }

  list(): Entry[] {
    return [...this.entries.values()];
  }

  setRole(key: string, value: string): void {
    this.write({ op: "role", key, value });
  }
  getRole(key: string): string | undefined {
    return this.roles.get(key);
  }

  addSipUsername(username: string): void {
    if (!this.sip.has(username)) this.write({ op: "sip", username });
  }
  sipUsernames(): string[] {
    return [...this.sip];
  }

  get runDir(): string | undefined {
    return this.dir;
  }

  saveSnapshot(name: string, data: unknown): void {
    if (!this.dir) return;
    fs.writeFileSync(path.join(this.dir, name), JSON.stringify(data, null, 2));
  }
  loadSnapshot<T>(name: string): T | undefined {
    if (!this.dir) return undefined;
    const f = path.join(this.dir, name);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as T) : undefined;
  }
}
