import { describe, it, expect } from "vitest";

describe("tokens/store integration", () => {
  it.todo(
    "pgp_sym_encrypt -> pgp_sym_decrypt round-trip preserves token bytes",
  );
  it.todo(
    "RLS: user can SELECT own row; cannot read another user's encrypted columns",
  );
  it.todo(
    "upsert with null refresh_token preserves existing refresh_token (COALESCE)",
  );
});
