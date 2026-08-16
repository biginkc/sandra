import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `processIngestChunk` is the workflow-level entry point. The unit test
// here verifies the countyId thread-through into the property insert.
// The full per-row dedup / contact / list / tag plumbing is covered by
// `ingest.integration.test.ts` against a real Postgres — this file is
// deliberately scoped to the new D-04 invariant.

vi.mock("./fips", () => ({
  // resolveFips reads `fips_codes` from the DB. For this unit test we
  // never need the real result — return a fixed string so the property
  // insert payload assertions stay stable.
  resolveFips: vi.fn().mockResolvedValue("29021"), // Buchanan County MO
}));

import { processIngestChunk } from "./ingest";

type Response = { data: unknown; error: { message: string } | null };

type CallRecord = {
  table: string;
  op: "select" | "insert" | "upsert" | "update";
  insertPayload?: unknown;
  filters: Array<{ op: string; args: unknown[] }>;
};

let responseQueue: Response[] = [];
let calls: CallRecord[] = [];
let durableOutcomes = new Map<
  string,
  { property_id: string; original_outcome: "inserted" | "duplicate" }
>();

function makeBuilder(record: CallRecord): Record<string, unknown> {
  const builder: Record<string, unknown> = {};

  const thenable = {
    then(
      onFulfilled: (v: Response) => unknown,
      onRejected?: (r: unknown) => unknown,
    ) {
      const resp = responseQueue.shift();
      if (!resp) {
        return Promise.reject(
          new Error(
            `ingest.test: no mock response queued for ${record.table}.${record.op}`,
          ),
        ).then(onFulfilled, onRejected);
      }
      return Promise.resolve(resp).then(onFulfilled, onRejected);
    },
  };

  builder.select = () => builder;
  builder.insert = (payload: unknown) => {
    record.insertPayload = payload;
    record.op = "insert";
    return builder;
  };
  builder.update = (payload: unknown) => {
    record.insertPayload = payload;
    record.op = "update";
    return builder;
  };
  builder.upsert = (payload: unknown) => {
    record.insertPayload = payload;
    record.op = "upsert";
    return builder;
  };
  builder.eq = (...args: unknown[]) => {
    record.filters.push({ op: "eq", args });
    return builder;
  };
  builder.or = (...args: unknown[]) => {
    record.filters.push({ op: "or", args });
    return builder;
  };
  builder.ilike = (...args: unknown[]) => {
    record.filters.push({ op: "ilike", args });
    return builder;
  };
  builder.is = (...args: unknown[]) => {
    record.filters.push({ op: "is", args });
    return builder;
  };
  builder.gte = (...args: unknown[]) => {
    record.filters.push({ op: "gte", args });
    return builder;
  };
  builder.lt = (...args: unknown[]) => {
    record.filters.push({ op: "lt", args });
    return builder;
  };
  builder.in = (...args: unknown[]) => {
    record.filters.push({ op: "in", args });
    return builder;
  };
  builder.limit = () => builder;
  builder.single = () => thenable;
  builder.maybeSingle = () => thenable;
  builder.then = thenable.then;

  return builder;
}

function makeSupabase() {
  return {
    from: vi.fn((table: string) => {
      const record: CallRecord = { table, op: "select", filters: [] };
      calls.push(record);
      return makeBuilder(record);
    }),
    rpc: vi.fn(
      async (
        name: string,
        args: {
          p_property?: Record<string, unknown>;
          p_org_id?: string;
          p_job_id?: string;
          p_source_row_index?: number;
          p_existing_property_id?: string | null;
          p_existing_patch?: Record<string, unknown>;
        },
      ) => {
        if (name !== "checkpoint_csv_import_property_outcome") {
          throw new Error(`ingest.test: unexpected RPC ${name}`);
        }
        const outcomeKey = `${args.p_job_id}:${args.p_source_row_index}`;
        const priorOutcome = durableOutcomes.get(outcomeKey);
        if (priorOutcome) return { data: [priorOutcome], error: null };
        const isDuplicate = Boolean(args.p_existing_property_id);
        calls.push({
          table: "properties",
          op: isDuplicate ? "update" : "insert",
          insertPayload: isDuplicate
            ? args.p_existing_patch
            : args.p_property,
          filters: isDuplicate
            ? [
                { op: "eq", args: ["id", args.p_existing_property_id] },
                { op: "eq", args: ["org_id", args.p_org_id] },
              ]
            : [],
        });
        const response = responseQueue.shift();
        if (!response) {
          throw new Error(
            "ingest.test: no mock response queued for checkpoint_csv_import_property_outcome",
          );
        }
        if (response.error) return { data: null, error: response.error };
        const legacy = response.data as { id?: string } | null;
        const outcome = {
          property_id: args.p_existing_property_id ?? legacy?.id ?? "prop-new",
          original_outcome: isDuplicate
            ? ("duplicate" as const)
            : ("inserted" as const),
        };
        durableOutcomes.set(outcomeKey, outcome);
        return { data: [outcome], error: null };
      },
    ),
  };
}

beforeEach(() => {
  responseQueue = [];
  calls = [];
  durableOutcomes = new Map();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("processIngestChunk → ingestRow countyId thread-through (phase 02 D-04)", () => {
  it("includes county_id alongside market on the property insert payload", async () => {
    // Single-row chunk; the wizard chose Buchanan County MO and threaded
    // the FK down through the workflow. The property insert MUST set
    // both market AND county_id together.
    const row = {
      Address: "123 Main St",
      State: "MO",
      Zip: "64015",
    };

    // processIngestChunk → validateRow (pure) → ingestRow
    //   ingestRow does not touch contacts (no homeowner/agent fields)
    //   then runs the dedup cascade — for a fresh address every cascade
    //   step queries for an existing match. None will be found here, so
    //   the worker reaches the property insert at line ~441.
    //
    // Sequence of mocked supabase calls in order:
    //   1. findExistingProperty: no fipsCode+apn → skip
    //      (no DB call because both keys would have to be present)
    //   2. findExistingProperty: zpid → null → skip (zpid absent)
    //   3. findExistingProperty: mlsNumber → null → skip (absent)
    //   4. findExistingProperty: addressNormalized → maybeSingle → null
    //   5. properties.insert(...).select.single → new id
    //   6. job_items.insert
    //   7. jobs.update (heartbeat / progress)
    responseQueue = [
      { data: null, error: null }, // 4. address dedup miss
      { data: { id: "prop-new" }, error: null }, // 5. property insert
      { data: null, error: null }, // 6. job_items insert
      { data: null, error: null }, // 7. jobs progress update
    ];

    await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        jobId: "job-1",
        csvImportId: "import-1",
        orgId: "org-1",
        source: "dealmachine",
        market: "Buchanan County MO",
        countyId: "buchanan-county-id",
        mapping: {
          address: "Address",
          state: "State",
          zip: "Zip",
        },
        rows: [row],
        offset: 0,
        autoTagIds: [],
        listId: null,
        userId: null,
      },
    );

    const propertyInsert = calls.find(
      (c) => c.table === "properties" && c.op === "insert",
    );
    expect(propertyInsert).toBeDefined();
    const payload = propertyInsert!.insertPayload as Record<string, unknown>;
    expect(payload.org_id).toBe("org-1");
    expect(payload.market).toBe("Buchanan County MO");
    expect(payload.county_id).toBe("buchanan-county-id");
  });

  it("passes county_id=null straight through when the workflow params do not provide it", async () => {
    // Defensive recovery branch failed (csv_imports.county_id was also
    // null) — the worker must still ingest the row, leaving county_id
    // null on the property. market is the only fallback the row keeps.
    const row = {
      Address: "456 Elm Ave",
      State: "KS",
      Zip: "66101",
    };
    responseQueue = [
      { data: null, error: null }, // address dedup miss
      { data: { id: "prop-new-2" }, error: null }, // insert
      { data: null, error: null }, // job_items insert
      { data: null, error: null }, // jobs heartbeat
    ];

    await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        jobId: "job-1",
        csvImportId: "import-1",
        orgId: "org-1",
        source: "dealmachine",
        market: "Johnson County KS",
        countyId: null,
        mapping: { address: "Address", state: "State", zip: "Zip" },
        rows: [row],
        offset: 0,
        autoTagIds: [],
        listId: null,
        userId: null,
      },
    );

    const propertyInsert = calls.find(
      (c) => c.table === "properties" && c.op === "insert",
    );
    expect(propertyInsert).toBeDefined();
    const payload = propertyInsert!.insertPayload as Record<string, unknown>;
    expect(payload.market).toBe("Johnson County KS");
    expect(payload.county_id).toBeNull();
  });
});

describe("processIngestChunk → hard rule: unlabeled phones are never saved", () => {
  // Shared chunk params; each test supplies its own mapping + rows.
  const baseChunkParams = {
    jobId: "job-1",
    csvImportId: "import-1",
    orgId: "org-1",
    source: "dealmachine",
    market: "Buchanan County MO",
    countyId: "buchanan-county-id",
    offset: 0,
    autoTagIds: [],
    listId: null,
    userId: null,
  };

  it("drops an unlabeled phone, compacts the labeled one into slot 1, and counts the drop", async () => {
    const row = {
      Address: "123 Main St",
      State: "MO",
      "First Name": "John",
      "Last Name": "Doe",
      "Phone 1": "816-555-0001", // no type column mapped → unknown → dropped
      "Phone 2": "816-555-0002",
      "Phone 2 Type": "mobile",
    };

    // ingestRow with homeowner fields:
    //   1. contacts phone-first match (compacted phone_1) → miss
    //   2. contacts insert → new id
    //   3. homeowner_details upsert
    //   4. address dedup → miss
    //   5. properties insert → new id
    //   6. job_items insert
    //   7. jobs progress update
    responseQueue = [
      { data: null, error: null },
      { data: { id: "contact-1" }, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: "prop-1" }, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_first_name: "First Name",
          homeowner_last_name: "Last Name",
          homeowner_phone_1: "Phone 1",
          homeowner_phone_2: "Phone 2",
          homeowner_phone_2_type: "Phone 2 Type",
        },
        rows: [row],
      },
    );

    const contactInsert = calls.find(
      (c) => c.table === "contacts" && c.op === "insert",
    );
    expect(contactInsert).toBeDefined();
    const payload = contactInsert!.insertPayload as Record<string, unknown>;
    // The labeled phone_2 compacted forward into slot 1; the unlabeled
    // phone never made it into any slot.
    expect(payload.phone_1).toBe("+18165550002");
    expect(payload.phone_1_type).toBe("mobile");
    expect(payload.phone_2).toBeNull();
    expect(payload.phone_3).toBeNull();
    expect(result.droppedUnlabeledPhones).toBe(1);
    const homeownerDetails = calls.find(
      (call) => call.table === "homeowner_details" && call.op === "upsert",
    );
    expect(homeownerDetails?.insertPayload).toMatchObject({ org_id: "org-1" });
  });

  it("keeps labeled phones in their slots with their types", async () => {
    const row = {
      Address: "123 Main St",
      State: "MO",
      "First Name": "John",
      "Phone 1": "816-555-0001",
      "Phone 1 Type": "mobile",
      "Phone 2": "816-555-0002",
      "Phone 2 Type": "landline",
    };

    responseQueue = [
      { data: null, error: null }, // phone match miss
      { data: { id: "contact-1" }, error: null }, // contact insert
      { data: null, error: null }, // homeowner_details upsert
      { data: null, error: null }, // address dedup miss
      { data: { id: "prop-1" }, error: null }, // property insert
      { data: null, error: null }, // job_items insert
      { data: null, error: null }, // jobs progress update
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_first_name: "First Name",
          homeowner_phone_1: "Phone 1",
          homeowner_phone_1_type: "Phone 1 Type",
          homeowner_phone_2: "Phone 2",
          homeowner_phone_2_type: "Phone 2 Type",
        },
        rows: [row],
      },
    );

    const contactInsert = calls.find(
      (c) => c.table === "contacts" && c.op === "insert",
    );
    const payload = contactInsert!.insertPayload as Record<string, unknown>;
    expect(payload.phone_1).toBe("+18165550001");
    expect(payload.phone_1_type).toBe("mobile");
    expect(payload.phone_2).toBe("+18165550002");
    expect(payload.phone_2_type).toBe("landline");
    expect(result.droppedUnlabeledPhones).toBe(0);
  });

  it("writes org_id on agent sidecar rows", async () => {
    responseQueue = [
      { data: null, error: null }, // agent phone miss
      { data: { id: "agent-contact" }, error: null },
      { data: null, error: null }, // agent_details upsert
      { data: null, error: null }, // address dedup miss
      { data: { id: "prop-agent" }, error: null },
      { data: null, error: null }, // job item
      { data: null, error: null }, // progress
    ];

    await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          agent_first_name: "Agent First",
          agent_phone: "Agent Phone",
          agent_phone_type: "Agent Phone Type",
        },
        rows: [{
          Address: "9 Agent Ave",
          State: "MO",
          "Agent First": "Alex",
          "Agent Phone": "8165552020",
          "Agent Phone Type": "mobile",
        }],
      },
    );

    const agentDetails = calls.find(
      (call) => call.table === "agent_details" && call.op === "upsert",
    );
    expect(agentDetails?.insertPayload).toMatchObject({ org_id: "org-1" });
  });

  it("still creates the contact (name/email kept) when EVERY phone is unlabeled", async () => {
    const row = {
      Address: "123 Main St",
      State: "MO",
      "First Name": "John",
      "Last Name": "Doe",
      Email: "john@example.com",
      "Phone 1": "816-555-0001",
      "Phone 2": "816-555-0002",
    };

    // No phone survives compaction, so upsertContact skips the
    // phone-first match and goes straight to the email match:
    //   1. contacts email match → miss
    //   2. contacts insert → new id
    //   3. homeowner_details upsert
    //   4. address dedup → miss
    //   5. properties insert → new id
    //   6. job_items insert
    //   7. jobs progress update
    responseQueue = [
      { data: null, error: null },
      { data: { id: "contact-1" }, error: null },
      { data: null, error: null },
      { data: null, error: null },
      { data: { id: "prop-1" }, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_first_name: "First Name",
          homeowner_last_name: "Last Name",
          homeowner_email: "Email",
          homeowner_phone_1: "Phone 1",
          homeowner_phone_2: "Phone 2",
        },
        rows: [row],
      },
    );

    const contactInsert = calls.find(
      (c) => c.table === "contacts" && c.op === "insert",
    );
    expect(contactInsert).toBeDefined();
    const payload = contactInsert!.insertPayload as Record<string, unknown>;
    expect(payload.first_name).toBe("John");
    expect(payload.last_name).toBe("Doe");
    expect(payload.email).toBe("john@example.com");
    expect(payload.phone_1).toBeNull();
    expect(payload.phone_2).toBeNull();
    expect(payload.phone_3).toBeNull();
    expect(result.droppedUnlabeledPhones).toBe(2);
    expect(result.succeeded).toBe(1);
  });
});

describe("processIngestChunk → DealMachine DNC ratchet (Codex PR #310 findings 1-3)", () => {
  const baseChunkParams = {
    jobId: "job-1",
    csvImportId: "import-1",
    orgId: "org-1",
    source: "dealmachine",
    market: "Buchanan County MO",
    countyId: "buchanan-county-id",
    offset: 0,
    autoTagIds: [],
    listId: null,
    userId: null,
  };

  it("matches + ratchets an existing contact via a DNC phone that is the row's ONLY identifier (finding 1)", async () => {
    // The DNC phone is dropped from phone_1 by the hard rule before any
    // match happens — with no name/email mapped, the old matcher (checking
    // only the surviving phone_1, now null) would fall through to INSERT
    // a brand-new contact while the real match sat unsuppressed.
    const row = {
      Address: "1 Compliance Way",
      State: "MO",
      "Phone 1": "8165557777",
      "Phone 1 Type": "DO NOT CALL",
    };

    responseQueue = [
      { data: { id: "existing-1" }, error: null }, // 1. phone match hit
      { data: null, error: null }, // 2. do_not_contact ratchet update
      { data: null, error: null }, // 3. homeowner_details upsert
      { data: null, error: null }, // 4. address dedup miss
      { data: { id: "prop-1" }, error: null }, // 5. property insert
      { data: null, error: null }, // 6. job_items insert
      { data: null, error: null }, // 7. jobs progress update
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_phone_1: "Phone 1",
          homeowner_phone_1_type: "Phone 1 Type",
        },
        rows: [row],
      },
    );

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);
    expect(
      calls.find((c) => c.table === "contacts" && c.op === "insert"),
    ).toBeUndefined();
    const ratchet = calls.find(
      (c) => c.table === "contacts" && c.op === "update",
    );
    expect(ratchet).toBeDefined();
    expect(ratchet!.insertPayload).toEqual({ do_not_contact: true });
    expect(ratchet!.filters).toContainEqual({ op: "eq", args: ["id", "existing-1"] });
  });

  it("matches + ratchets an existing contact via a DNC phone in a SECONDARY slot (Phone 2), with a clean unmatched Phone 1 (secondary-slot match)", async () => {
    const row = {
      Address: "2 Compliance Way",
      State: "MO",
      "Phone 1": "8165551111",
      "Phone 1 Type": "Mobile",
      "Phone 2": "8165557777",
      "Phone 2 Type": "DO NOT CALL",
    };

    responseQueue = [
      { data: null, error: null }, // 1. phone_1 (clean, survives) → no match
      { data: { id: "existing-2" }, error: null }, // 2. dropped Phone 2 (DNC) → match
      { data: null, error: null }, // 3. do_not_contact ratchet update
      { data: null, error: null }, // 4. homeowner_details upsert
      { data: null, error: null }, // 5. address dedup miss
      { data: { id: "prop-2" }, error: null }, // 6. property insert
      { data: null, error: null }, // 7. job_items insert
      { data: null, error: null }, // 8. jobs progress update
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_phone_1: "Phone 1",
          homeowner_phone_1_type: "Phone 1 Type",
          homeowner_phone_2: "Phone 2",
          homeowner_phone_2_type: "Phone 2 Type",
        },
        rows: [row],
      },
    );

    expect(result.succeeded).toBe(1);
    expect(
      calls.find((c) => c.table === "contacts" && c.op === "insert"),
    ).toBeUndefined();
    const ratchet = calls.find(
      (c) => c.table === "contacts" && c.op === "update",
    );
    expect(ratchet).toBeDefined();
    expect(ratchet!.filters).toContainEqual({ op: "eq", args: ["id", "existing-2"] });
    // Slot 1's clean number was checked FIRST (priority order preserved)
    // and correctly missed before slot 2's dropped DNC number matched.
    const phoneSelects = calls.filter(
      (c) => c.table === "contacts" && c.op === "select",
    );
    expect(phoneSelects.length).toBeGreaterThanOrEqual(2);
    expect(phoneSelects[0].filters).toContainEqual({
      op: "or",
      args: [
        "phone_1.eq.+18165551111,phone_2.eq.+18165551111,phone_3.eq.+18165551111",
      ],
    });
    expect(phoneSelects[1].filters).toContainEqual({
      op: "or",
      args: [
        "phone_1.eq.+18165557777,phone_2.eq.+18165557777,phone_3.eq.+18165557777",
      ],
    });
  });

  it("fails the row (job_items error, database class) when the do_not_contact ratchet update returns a DB error (finding 2)", async () => {
    const row = {
      Address: "3 Compliance Way",
      State: "MO",
      "Phone 1": "8165557777",
      "Phone 1 Type": "DO NOT CALL",
    };

    responseQueue = [
      { data: { id: "existing-1" }, error: null }, // 1. phone match hit
      { data: null, error: { message: "connection reset" } }, // 2. ratchet update FAILS
      { data: null, error: null }, // 3. job_items error insert
      { data: null, error: null }, // 4. jobs progress update
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_phone_1: "Phone 1",
          homeowner_phone_1_type: "Phone 1 Type",
        },
        rows: [row],
      },
    );

    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0]?.message).toContain("do_not_contact ratchet update failed");
    const errorItem = calls.find(
      (c) => c.table === "job_items" && c.op === "upsert",
    );
    expect(errorItem).toBeDefined();
    const payload = errorItem!.insertPayload as Record<string, unknown>;
    expect(payload.status).toBe("error");
    expect(payload.error_class).toBe("database");
  });

  it("creates a flagged contact for a DNC-only row with no name/email/surviving phone (REISift/PropStream-shape, finding 3)", async () => {
    // REISift's "DNC Excluded" sentinel nulls the phone entirely; when the
    // row carries no other homeowner identifier, the old hasHomeownerFields()
    // skipped upsertContact() completely — the flag was dropped on the
    // floor with no contact to attach it to.
    const row = {
      Address: "4 Compliance Way",
      State: "MO",
      "DNC Flag": "true",
    };

    responseQueue = [
      { data: { id: "contact-new" }, error: null }, // 1. contacts insert (no match possible)
      { data: null, error: null }, // 2. homeowner_details upsert
      { data: null, error: null }, // 3. address dedup miss
      { data: { id: "prop-4" }, error: null }, // 4. property insert
      { data: null, error: null }, // 5. job_items insert
      { data: null, error: null }, // 6. jobs progress update
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_do_not_contact: "DNC Flag",
        },
        rows: [row],
      },
    );

    expect(result.succeeded).toBe(1);
    const contactInsert = calls.find(
      (c) => c.table === "contacts" && c.op === "insert",
    );
    expect(contactInsert).toBeDefined();
    const payload = contactInsert!.insertPayload as Record<string, unknown>;
    expect(payload.do_not_contact).toBe(true);
  });

  it("ratchets an existing contact matched by a clean phone when the DNC flag arrives pre-decoded (PropStream/REISift shape — the flag was set by the vendor preset, not Pass 1b)", async () => {
    const row = {
      Address: "5 Compliance Way",
      State: "MO",
      Phone: "8165551111",
      "Phone Type": "Mobile",
      "DNC Flag": "true",
    };

    responseQueue = [
      { data: { id: "existing-3" }, error: null }, // 1. phone match hit
      { data: null, error: null }, // 2. do_not_contact ratchet update
      { data: null, error: null }, // 3. homeowner_details upsert
      { data: null, error: null }, // 4. address dedup miss
      { data: { id: "prop-5" }, error: null }, // 5. property insert
      { data: null, error: null }, // 6. job_items insert
      { data: null, error: null }, // 7. jobs progress update
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_phone_1: "Phone",
          homeowner_phone_1_type: "Phone Type",
          homeowner_do_not_contact: "DNC Flag",
        },
        rows: [row],
      },
    );

    expect(result.succeeded).toBe(1);
    expect(
      calls.find((c) => c.table === "contacts" && c.op === "insert"),
    ).toBeUndefined();
    const ratchet = calls.find(
      (c) => c.table === "contacts" && c.op === "update",
    );
    expect(ratchet).toBeDefined();
    expect(ratchet!.insertPayload).toEqual({ do_not_contact: true });
    expect(ratchet!.filters).toContainEqual({ op: "eq", args: ["id", "existing-3"] });
  });

  it("locks a dedup-matched property even when it already links a different homeowner", async () => {
    responseQueue = [
      { data: { id: "incoming-contact" }, error: null },
      { data: null, error: null }, // homeowner details
      { data: { id: "existing-property" }, error: null }, // address dedup
      {
        data: { homeowner_contact_id: "different-contact", agent_contact_id: null },
        error: null,
      },
      { data: null, error: null }, // property suppression/provenance ratchet
      { data: null, error: null }, // job item checkpoint
      { data: null, error: null }, // progress checkpoint
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_do_not_contact: "DNC Flag",
        },
        rows: [{ Address: "55 Locked Ln", State: "MO", "DNC Flag": "true" }],
      },
    );

    expect(result.skipped).toBe(1);
    const propertyUpdate = calls.find(
      (call) => call.table === "properties" && call.op === "update",
    );
    expect(propertyUpdate?.insertPayload).toMatchObject({
      outreach_dispo: "dnc",
      source_import_id: "import-1",
    });
    expect(propertyUpdate?.insertPayload).not.toHaveProperty("homeowner_contact_id");
  });

  it("PropStream-shaped row: a DNC number with no clean phone still matches + ratchets an existing contact (Codex round-2 finding B)", async () => {
    // Mirrors what propstreamPreset.transform() now produces when a DNC
    // number is the ONLY phone on the row: the number itself lands in
    // homeowner_phone_1, but its type column is empty (never the vendor's
    // real Mobile/Landline label) so ingest.ts's hard rule drops it from
    // storage while still carrying it into matchPhones via droppedPhones.
    const row = {
      Address: "6 Compliance Way",
      State: "MO",
      Phone: "8165551111",
      "Phone Type": "", // PropStream writes "" for a DNC slot's type
      "DNC Flag": "true",
    };

    responseQueue = [
      { data: { id: "existing-4" }, error: null }, // 1. dropped DNC phone matches
      { data: null, error: null }, // 2. do_not_contact ratchet update
      { data: null, error: null }, // 3. homeowner_details upsert
      { data: null, error: null }, // 4. address dedup miss
      { data: { id: "prop-6" }, error: null }, // 5. property insert
      { data: null, error: null }, // 6. job_items insert
      { data: null, error: null }, // 7. jobs progress update
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_phone_1: "Phone",
          homeowner_phone_1_type: "Phone Type",
          homeowner_do_not_contact: "DNC Flag",
        },
        rows: [row],
      },
    );

    expect(result.succeeded).toBe(1);
    expect(
      calls.find((c) => c.table === "contacts" && c.op === "insert"),
    ).toBeUndefined();
    const ratchet = calls.find(
      (c) => c.table === "contacts" && c.op === "update",
    );
    expect(ratchet).toBeDefined();
    expect(ratchet!.filters).toContainEqual({ op: "eq", args: ["id", "existing-4"] });
  });

  it("matching queries phone_1, phone_2, AND phone_3 on the existing contact — not just phone_1 (Codex round-2 finding A)", async () => {
    // A DNC number could already be sitting in an existing contact's
    // phone_2 or phone_3 slot (e.g. packed there by an earlier skip-trace
    // run). A phone_1-only lookup would never find it.
    const row = {
      Address: "7 Compliance Way",
      State: "MO",
      "Phone 1": "8165557777",
      "Phone 1 Type": "DO NOT CALL",
    };

    responseQueue = [
      { data: { id: "existing-5" }, error: null }, // 1. match (any slot)
      { data: null, error: null }, // 2. do_not_contact ratchet update
      { data: null, error: null }, // 3. homeowner_details upsert
      { data: null, error: null }, // 4. address dedup miss
      { data: { id: "prop-7" }, error: null }, // 5. property insert
      { data: null, error: null }, // 6. job_items insert
      { data: null, error: null }, // 7. jobs progress update
    ];

    await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_phone_1: "Phone 1",
          homeowner_phone_1_type: "Phone 1 Type",
        },
        rows: [row],
      },
    );

    const phoneSelect = calls.find(
      (c) => c.table === "contacts" && c.op === "select",
    );
    expect(phoneSelect).toBeDefined();
    expect(phoneSelect!.filters).toContainEqual({
      op: "or",
      args: [
        "phone_1.eq.+18165557777,phone_2.eq.+18165557777,phone_3.eq.+18165557777",
      ],
    });
  });

  it("3 clean phones fill all storage slots, but the DNC number on the identity-only channel is what finds and ratchets the existing contact (Codex round-3 finding)", async () => {
    // Mirrors what propstreamPreset.transform() produces for a row with 3
    // clean phones AND a 4th DNC-flagged one: homeowner_phone_1/2/3 are
    // full (no room for the DNC number), but homeowner_dnc_phones still
    // carries it. The incoming phone_1 doesn't match anything — only the
    // DNC identity number does — so the phone-match loop must reach past
    // the surviving phone_1 into identityOnlyDncPhones to find it. (Only
    // phone_1 among the row's SURVIVING phones is ever checked — matching
    // on incoming phone_2/phone_3 is unchanged, out-of-scope behavior;
    // this test exercises the identity-only channel specifically.)
    const row = {
      Address: "8 Compliance Way",
      State: "MO",
      "Phone 1": "8165551001",
      "Phone 1 Type": "Mobile",
      "Phone 2": "8165551002",
      "Phone 2 Type": "Mobile",
      "Phone 3": "8165551003",
      "Phone 3 Type": "Mobile",
      // `homeowner_dnc_phones` is a "text" field (validate.ts's Pass 1
      // does not run phone normalization on it) — the value here is
      // pre-normalized, exactly as propstreamPreset.transform() would
      // have written it via normalizePhone() before this row ever reaches
      // validate.ts.
      "DNC Phones": "+18165559999",
      "DNC Flag": "true",
    };

    responseQueue = [
      { data: null, error: null }, // 1. incoming phone_1 → miss
      { data: { id: "existing-6" }, error: null }, // 2. DNC identity phone → match
      { data: null, error: null }, // 3. do_not_contact ratchet update
      { data: null, error: null }, // 4. homeowner_details upsert
      { data: null, error: null }, // 5. address dedup miss
      { data: { id: "prop-8" }, error: null }, // 6. property insert
      { data: null, error: null }, // 7. job_items insert
      { data: null, error: null }, // 8. jobs progress update
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        ...baseChunkParams,
        mapping: {
          address: "Address",
          state: "State",
          homeowner_phone_1: "Phone 1",
          homeowner_phone_1_type: "Phone 1 Type",
          homeowner_phone_2: "Phone 2",
          homeowner_phone_2_type: "Phone 2 Type",
          homeowner_phone_3: "Phone 3",
          homeowner_phone_3_type: "Phone 3 Type",
          homeowner_dnc_phones: "DNC Phones",
          homeowner_do_not_contact: "DNC Flag",
        },
        rows: [row],
      },
    );

    expect(result.succeeded).toBe(1);
    expect(
      calls.find((c) => c.table === "contacts" && c.op === "insert"),
    ).toBeUndefined();
    const ratchet = calls.find(
      (c) => c.table === "contacts" && c.op === "update",
    );
    expect(ratchet).toBeDefined();
    expect(ratchet!.filters).toContainEqual({ op: "eq", args: ["id", "existing-6"] });
    const phoneSelects = calls.filter(
      (c) => c.table === "contacts" && c.op === "select",
    );
    expect(phoneSelects).toHaveLength(2);
    expect(phoneSelects[1].filters).toContainEqual({
      op: "or",
      args: [
        "phone_1.eq.+18165559999,phone_2.eq.+18165559999,phone_3.eq.+18165559999",
      ],
    });
  });
});

describe("processIngestChunk durable resume", () => {
  it("skips a checkpointed success and retries only the failed source row", async () => {
    responseQueue = [
      { data: [
        { source_row_index: 0, status: "success" },
        { source_row_index: 1, status: "error" },
      ], error: null },
      { data: null, error: null }, // row 1 address dedup miss
      { data: { id: "prop-row-1" }, error: null },
      { data: null, error: null }, // row checkpoint upsert
      { data: null, error: null }, // progress
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        jobId: "job-resume",
        orgId: "org-1",
        csvImportId: "import-resume",
        source: "dealmachine",
        market: "Buchanan County MO",
        countyId: "county-1",
        mapping: { address: "Address", state: "State" },
        rows: [
          { Address: "1 Already Done St", State: "MO" },
          { Address: "2 Retry St", State: "MO" },
        ],
        offset: 0,
        autoTagIds: [],
        resumeSafe: true,
      },
    );

    expect(result).toMatchObject({ succeeded: 2, failed: 0 });
    const propertyWrites = calls.filter(
      (call) => call.table === "properties" && call.op === "insert",
    );
    expect(propertyWrites).toHaveLength(1);
    expect((propertyWrites[0].insertPayload as Record<string, unknown>).address).toBe("2 Retry ST");
    const checkpoint = calls.find(
      (call) => call.table === "job_items" && call.op === "upsert",
    );
    expect(checkpoint?.insertPayload).toMatchObject({ source_row_index: 1, status: "success" });
  });
});

describe("processIngestChunk dedup provenance", () => {
  it("refreshes latest-import provenance for an address-only dedup match", async () => {
    responseQueue = [
      { data: { id: "existing-address-only" }, error: null },
      { data: null, error: null }, // provenance update
      { data: null, error: null }, // job item
      { data: null, error: null }, // progress
    ];

    const result = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      {
        jobId: "job-provenance",
        csvImportId: "import-latest",
        orgId: "org-1",
        source: "dealmachine",
        market: "Buchanan County MO",
        countyId: "county-1",
        mapping: { address: "Address", state: "State" },
        rows: [{ Address: "10 Existing St", State: "MO" }],
        offset: 0,
        autoTagIds: [],
        listId: null,
      },
    );

    expect(result.skipped).toBe(1);
    const update = calls.find(
      (call) => call.table === "properties" && call.op === "update",
    );
    expect(update?.insertPayload).toMatchObject({
      source_import_id: "import-latest",
    });
    expect(update?.insertPayload).toHaveProperty("source_imported_at");
    expect(update?.filters).toContainEqual({ op: "eq", args: ["org_id", "org-1"] });
  });
});

describe("processIngestChunk atomic property outcome replay", () => {
  const params = {
    jobId: "job-boundary",
    csvImportId: "import-boundary",
    orgId: "org-1",
    source: "dealmachine",
    market: "Buchanan County MO",
    countyId: "county-1",
    mapping: { address: "Address", state: "State" },
    rows: [{ Address: "99 Boundary St", State: "MO" }],
    offset: 0,
    autoTagIds: [] as string[],
    listId: null as string | null,
    resumeSafe: true,
  };

  it.each([
    {
      boundary: "list",
      options: { listId: "list-1", autoTagIds: [] as string[] },
      beforeFailure: [{ data: { org_id: "org-1" }, error: null }] as Response[],
      failure: { data: null, error: { message: "synthetic list failure" } },
      replaySideEffects: [
        { data: { org_id: "org-1" }, error: null },
        { data: null, error: null },
      ],
    },
    {
      boundary: "tag",
      options: { listId: null, autoTagIds: ["tag-1"] },
      beforeFailure: [] as Response[],
      failure: { data: null, error: { message: "synthetic tag failure" } },
      replaySideEffects: [{ data: null, error: null }],
    },
    {
      boundary: "success checkpoint",
      options: { listId: null, autoTagIds: [] as string[] },
      beforeFailure: [] as Response[],
      failure: { data: null, error: { message: "synthetic checkpoint failure" } },
      replaySideEffects: [] as Response[],
    },
  ])(
    "preserves inserted (not duplicate) after a $boundary failure",
    async ({ options, beforeFailure, failure, replaySideEffects }) => {
      responseQueue = [
        { data: [], error: null }, // resume checkpoint miss
        { data: null, error: null }, // address dedup miss
        { data: { id: "prop-boundary" }, error: null }, // atomic property outcome
        ...beforeFailure,
        failure, // selected side effect / success checkpoint
        { data: null, error: null }, // error checkpoint
        { data: null, error: null }, // progress
      ];
      const first = await processIngestChunk(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase() as any,
        { ...params, ...options },
      );
      expect(first.failed).toBe(1);

      responseQueue = [
        { data: [{ source_row_index: 0, status: "error" }], error: null },
        { data: { id: "prop-boundary" }, error: null }, // address now exists
        ...replaySideEffects,
        { data: null, error: null }, // success checkpoint
        { data: null, error: null }, // progress
      ];
      const replay = await processIngestChunk(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase() as any,
        { ...params, ...options },
      );
      expect(replay).toMatchObject({ succeeded: 1, skipped: 0, failed: 0 });
      expect(
        calls.filter(
          (call) => call.table === "properties" && call.op === "insert",
        ),
      ).toHaveLength(1);
    },
  );

  it("skips the durable row after progress fails following its success checkpoint", async () => {
    responseQueue = [
      { data: [], error: null },
      { data: null, error: null },
      { data: { id: "prop-boundary" }, error: null },
      { data: null, error: null }, // success checkpoint
      { data: null, error: { message: "synthetic progress failure" } },
    ];
    await expect(
      processIngestChunk(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeSupabase() as any,
        params,
      ),
    ).rejects.toThrow("job progress checkpoint");

    responseQueue = [
      { data: [{ source_row_index: 0, status: "success" }], error: null },
    ];
    const replay = await processIngestChunk(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeSupabase() as any,
      params,
    );
    expect(replay).toMatchObject({ succeeded: 1, skipped: 0, failed: 0 });
    expect(
      calls.filter(
        (call) => call.table === "properties" && call.op === "insert",
      ),
    ).toHaveLength(1);
  });
});
