import { AppError } from "./classes";

export type AppErrorShape = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

export type Result<T, E = AppErrorShape> =
  | { ok: true; data: T }
  | { ok: false; error: E };

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

export function err<E = AppErrorShape>(error: E): { ok: false; error: E } {
  return { ok: false, error };
}

const errorNameToCode = (name: string): string =>
  name
    .replace(/Error$/, "")
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .toUpperCase() || "UNKNOWN";

export function errFromUnknown(
  e: unknown,
  fallbackCode = "UNKNOWN_ERROR",
): { ok: false; error: AppErrorShape } {
  if (e instanceof AppError) {
    return err({
      code: errorNameToCode(e.name) || fallbackCode,
      message: e.message,
      details: e.details,
    });
  }
  if (e instanceof Error) {
    return err({
      code: errorNameToCode(e.name) || fallbackCode,
      message: e.message,
    });
  }
  return err({
    code: fallbackCode,
    message: typeof e === "string" ? e : JSON.stringify(e),
  });
}
