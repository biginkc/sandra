import { describe, expect, it } from "vitest";

import { ProviderError, ValidationError } from "./classes";
import { err, errFromUnknown, ok } from "./result";

describe("ok()", () => {
  it("wraps data in a success-shaped Result", () => {
    const r = ok({ id: "abc" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data).toEqual({ id: "abc" });
    }
  });

  it("handles primitive payloads", () => {
    expect(ok(42)).toEqual({ ok: true, data: 42 });
    expect(ok("hello")).toEqual({ ok: true, data: "hello" });
    expect(ok(null)).toEqual({ ok: true, data: null });
  });
});

describe("err()", () => {
  it("wraps an error-shaped Result", () => {
    const r = err({ code: "X", message: "y" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toEqual({ code: "X", message: "y" });
    }
  });
});

describe("errFromUnknown() — AppError", () => {
  it("preserves code, message, and details from AppError", () => {
    const r = errFromUnknown(
      new ValidationError("bad input", { field: "email" }),
    );
    expect(r.ok).toBe(false);
    expect(r.error.code).toBe("VALIDATION");
    expect(r.error.message).toBe("bad input");
    expect(r.error.details).toEqual({ field: "email" });
  });

  it("derives SCREAMING_SNAKE codes from multi-word class names", () => {
    const r = errFromUnknown(new ProviderError("timeout", "smartystreets"));
    expect(r.error.code).toBe("PROVIDER");
  });
});

describe("errFromUnknown() — generic Error", () => {
  it("derives code UNKNOWN for a plain Error (name='Error')", () => {
    const r = errFromUnknown(new Error("boom"));
    expect(r.error.message).toBe("boom");
    expect(r.error.code).toBe("UNKNOWN");
  });

  it("derives code from built-in Error subclasses", () => {
    const r = errFromUnknown(new TypeError("bad type"));
    expect(r.error.code).toBe("TYPE");
    expect(r.error.message).toBe("bad type");
  });
});

describe("errFromUnknown() — non-Error input", () => {
  it("handles strings", () => {
    const r = errFromUnknown("something went wrong", "GENERIC");
    expect(r.error.code).toBe("GENERIC");
    expect(r.error.message).toBe("something went wrong");
  });

  it("handles objects via JSON.stringify", () => {
    const r = errFromUnknown({ a: 1 }, "FALLBACK");
    expect(r.error.code).toBe("FALLBACK");
    expect(r.error.message).toContain('"a":1');
  });

  it("handles undefined", () => {
    const r = errFromUnknown(undefined, "FALLBACK");
    expect(r.error.code).toBe("FALLBACK");
  });
});
