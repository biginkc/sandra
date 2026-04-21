import { AppError, type ErrorClass } from "./classes";

export function classifyError(err: unknown): ErrorClass {
  if (err instanceof AppError) return err.errorClass;

  if (err && typeof err === "object") {
    if ("code" in err) {
      const code = String((err as { code: unknown }).code);
      if (code.startsWith("23")) return "database";
      if (code.startsWith("42")) return "database";
      if (code.startsWith("28")) return "authorization";
      if (code === "PGRST301" || code === "PGRST302") return "authorization";
    }
    if ("status" in err) {
      const status = Number((err as { status: unknown }).status);
      if (status === 401 || status === 403) return "authorization";
      if (status === 429) return "transient";
      if (status >= 500 && status < 600) return "transient";
      if (status >= 400 && status < 500) return "provider";
    }
  }

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (
      msg.includes("timeout") ||
      msg.includes("econnrefused") ||
      msg.includes("enotfound") ||
      msg.includes("network")
    ) {
      return "transient";
    }
  }

  return "provider";
}

export function isRetryable(errorClass: ErrorClass): boolean {
  return errorClass === "transient";
}
