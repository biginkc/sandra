/* eslint-disable @typescript-eslint/no-explicit-any */
// Minimal receive-only WebSocket server (no dependency) for Telnyx media streams.
// Logs the start-frame media format and per-track byte counts. Raw audio is never stored.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { EventLog } from "./event-log";

export interface Frame {
  opcode: number;
  payload: Buffer;
}

export const MAX_FRAME_BYTES = 256 * 1024;
export const MAX_BUFFER_BYTES = 1024 * 1024;

export class OversizeError extends Error {}

/** Parses client (masked) frames; throws OversizeError if a frame declares more than maxFrame bytes. */
export function parseFrames(buf: Buffer, maxFrame = MAX_FRAME_BYTES): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off];
    const b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p);
      p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      len = Number(buf.readBigUInt64BE(p));
      p += 8;
    }
    if (len > maxFrame) throw new OversizeError(`frame of ${len} bytes exceeds cap ${maxFrame}`);
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    const mask = masked ? buf.subarray(p, p + 4) : undefined;
    p += maskLen;
    const payload = Buffer.from(buf.subarray(p, p + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    frames.push({ opcode, payload });
    off = p + len;
  }
  return { frames, rest: buf.subarray(off) };
}

export interface StreamStats {
  startFrames: unknown[];
  bytesByTrack: Record<string, number>;
}

/** Handle one decoded text message from Telnyx. Exported for tests. */
export function handleStreamMessage(text: string, stats: StreamStats, log?: EventLog): void {
  let m: any;
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  if (m.event === "start") {
    stats.startFrames.push(m.start ?? m);
    log?.append({ source: "stream", type: "stream.start", data: { media_format: m.start?.media_format, stream_id: m.stream_id } });
  } else if (m.event === "media") {
    const track: string = m.media?.track ?? "unknown";
    const bytes = Buffer.from(m.media?.payload ?? "", "base64").length;
    stats.bytesByTrack[track] = (stats.bytesByTrack[track] ?? 0) + bytes;
  } else if (m.event === "stop") {
    log?.append({ source: "stream", type: "stream.stop", data: { bytesByTrack: { ...stats.bytesByTrack } } });
  }
}

/** True only for `/stream/<token>` (token also accepted as ?token=) with the exact run token. */
export function streamTokenOk(url: string | undefined, token: string): boolean {
  if (!url || !token) return false;
  const u = new URL(url, "http://x");
  const m = /^\/stream\/([^/]+)$/.exec(u.pathname);
  const given = m ? decodeURIComponent(m[1]) : u.pathname === "/stream" ? (u.searchParams.get("token") ?? "") : "";
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function attachStreamServer(server: Server, log: EventLog, stats: StreamStats, opts: { token: string; maxFrame?: number; maxBuffer?: number }): void {
  const maxFrame = opts.maxFrame ?? MAX_FRAME_BYTES;
  const maxBuffer = opts.maxBuffer ?? MAX_BUFFER_BYTES;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex) => {
    if (!streamTokenOk(req.url, opts.token)) return void socket.destroy();
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") return void socket.destroy();
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let pending: Buffer = Buffer.alloc(0);
    let message: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => {
      if (pending.length + chunk.length > maxBuffer + maxFrame) return void socket.destroy();
      let r: ReturnType<typeof parseFrames>;
      try {
        r = parseFrames(Buffer.concat([pending, chunk]), maxFrame);
      } catch {
        return void socket.destroy();
      }
      pending = Buffer.from(r.rest);
      for (const f of r.frames) {
        if (f.opcode === 0x8) return void socket.end();
        if (f.opcode === 0x9) socket.write(Buffer.concat([Buffer.from([0x8a, f.payload.length]), f.payload]));
        else if (f.opcode === 0x1 || f.opcode === 0x0 || f.opcode === 0x2) {
          message.push(f.payload);
          handleStreamMessage(Buffer.concat(message).toString("utf8"), stats, log);
          message = [];
        }
      }
    });
    socket.on("error", () => socket.destroy());
  });
}
