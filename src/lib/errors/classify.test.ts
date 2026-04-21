import { describe, expect, it } from "vitest";

import {
  AuthorizationError,
  DatabaseError,
  ProviderError,
  TransientError,
  ValidationError,
} from "./classes";
import { classifyError, isRetryable } from "./classify";

describe("classifyError — AppError subclasses", () => {
  it("returns the errorClass for each AppError subclass", () => {
    expect(classifyError(new ValidationError("bad"))).toBe("validation");
    expect(classifyError(new TransientError("flaky"))).toBe("transient");
    expect(classifyError(new DatabaseError("pg"))).toBe("database");
    expect(classifyError(new AuthorizationError("403"))).toBe("authorization");
    expect(classifyError(new ProviderError("smarty", "smartystreets"))).toBe(
      "provider",
    );
  });
});

describe("classifyError — Postgres error codes", () => {
  it("treats 23xxx integrity errors as database", () => {
    expect(classifyError({ code: "23505" })).toBe("database");
    expect(classifyError({ code: "23503" })).toBe("database");
  });

  it("treats 42xxx syntax/permission errors as database", () => {
    expect(classifyError({ code: "42P01" })).toBe("database");
  });

  it("treats 28xxx authentication errors as authorization", () => {
    expect(classifyError({ code: "28000" })).toBe("authorization");
  });

  it("treats PostgREST permission codes as authorization", () => {
    expect(classifyError({ code: "PGRST301" })).toBe("authorization");
    expect(classifyError({ code: "PGRST302" })).toBe("authorization");
  });
});

describe("classifyError — HTTP status heuristics", () => {
  it("401/403 → authorization", () => {
    expect(classifyError({ status: 401 })).toBe("authorization");
    expect(classifyError({ status: 403 })).toBe("authorization");
  });

  it("429 → transient (rate limit)", () => {
    expect(classifyError({ status: 429 })).toBe("transient");
  });

  it("5xx → transient", () => {
    expect(classifyError({ status: 500 })).toBe("transient");
    expect(classifyError({ status: 502 })).toBe("transient");
    expect(classifyError({ status: 503 })).toBe("transient");
  });

  it("other 4xx → provider", () => {
    expect(classifyError({ status: 400 })).toBe("provider");
    expect(classifyError({ status: 404 })).toBe("provider");
  });
});

describe("classifyError — network error messages", () => {
  it("recognizes transient keywords in Error.message", () => {
    expect(classifyError(new Error("Request timeout"))).toBe("transient");
    expect(classifyError(new Error("ECONNREFUSED 127.0.0.1"))).toBe(
      "transient",
    );
    expect(classifyError(new Error("getaddrinfo ENOTFOUND supa"))).toBe(
      "transient",
    );
    expect(classifyError(new Error("network error"))).toBe("transient");
  });

  it("falls back to provider for anything unrecognized", () => {
    expect(classifyError(new Error("something weird"))).toBe("provider");
    expect(classifyError("just a string")).toBe("provider");
    expect(classifyError(42)).toBe("provider");
    expect(classifyError(undefined)).toBe("provider");
  });
});

describe("isRetryable", () => {
  it("only transient is retryable", () => {
    expect(isRetryable("transient")).toBe(true);
    expect(isRetryable("validation")).toBe(false);
    expect(isRetryable("database")).toBe(false);
    expect(isRetryable("provider")).toBe(false);
    expect(isRetryable("authorization")).toBe(false);
    expect(isRetryable("configuration")).toBe(false);
  });
});
