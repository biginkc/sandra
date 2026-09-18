import { Client } from "pg";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../src/lib/supabase/types";
import { assertDisposableE2EDatabaseEnvironment } from "../../src/lib/supabase/e2e-target-safety";
import {
  DEFAULT_ORG_ID,
  countOrgScopedFixtureRows,
  deleteOrgScopedFixtureRows,
} from "../fixtures";
import {
  decodeAcceptanceProjectionState,
  isAcceptanceProjectionDrained,
  type AcceptanceProjectionState,
  type AcceptanceProjectionStateRow,
} from "./cleanup-state.mjs";

/**
 * The acceptance suite is allowed to mutate only this disposable database.
 * The API target guard in adminClient() protects the row-level cleanup; this
 * second guard protects the read-only projection connection used for drain
 * evidence. Keep these values exact: accepting an arbitrary DATABASE_URL
 * would make a failed drain probe a dangerous false negative.
 */
const ACCEPTANCE_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const ACCEPTANCE_DATABASE_MARKER =
  "sandra-inbox-http-owned-synthetic-20260917";
const DRAIN_ATTEMPTS = 40;
const DRAIN_INTERVAL_MS = 250;

type CleanupProtection = {
  lockedPropertyIds: Set<string>;
  retainedContactIds: Set<string>;
  retainedPropertyIds: Set<string>;
};

export type AcceptanceProjectionTarget =
  | { kind: "known_conversation"; id: string; unread: boolean }
  | { kind: "unknown_sender"; rawSender: string; dismissed: boolean };

/**
 * Read only, org-scoped projection state. The queue/work tables are private
 * worker state, so this intentionally uses the guarded postgres connection
 * instead of granting service_role access to inbox_* schemas. The derived
 * counts make the drain condition meaningful: an empty queue alone cannot
 * prove that a previous TRUNCATE did not leave stale summaries behind.
 */
export const ACCEPTANCE_PROJECTION_STATE_SQL = `
  SELECT
    EXISTS (
      SELECT 1 FROM inbox_maintained.queue
      WHERE org_id = $1::uuid
    ) AS queue_pending,
    EXISTS (
      SELECT 1 FROM inbox_parent.work
      WHERE org_id = $1::uuid AND generation > ack
    ) AS parent_pending,
    EXISTS (
      SELECT 1 FROM inbox_safety.routes
      WHERE org_id = $1::uuid AND generation > ack
    ) AS safety_pending,
    (SELECT count(*)::integer
       FROM inbox_maintained.rows
      WHERE org_id = $1::uuid
        -- Deletion publishes an acknowledged exists=false tombstone and
        -- intentionally retains that row for generation fencing. Count only
        -- live or malformed rows as residual projection state.
        AND (summary->>'exists') IS DISTINCT FROM 'false') AS maintained_rows,
    (SELECT count(*)::integer FROM inbox_bridge.summaries WHERE org_id = $1::uuid)
      AS summary_rows,
    (SELECT count(*)::integer FROM inbox_bridge.filter_rows WHERE org_id = $1::uuid)
      AS filter_rows
`;

async function readProjectionState(
  client: Client,
  orgId: string,
): Promise<AcceptanceProjectionState> {
  // Each observation is its own read-only transaction. A single long-lived
  // transaction would keep one MVCC snapshot and could never observe a worker
  // round that commits after the first poll.
  await client.query("BEGIN READ ONLY");
  try {
    const result = await client.query<AcceptanceProjectionStateRow>(
      ACCEPTANCE_PROJECTION_STATE_SQL,
      [orgId],
    );
    await client.query("COMMIT");
    const row = result.rows[0];
    if (!row) throw new Error("Projection drain probe returned no state row.");
    return decodeAcceptanceProjectionState(row);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

function formatState(state: AcceptanceProjectionState): string {
  return JSON.stringify(state);
}

async function openProjectionProbe(): Promise<Client> {
  const databaseUrl = process.env.E2E_CI_SUPABASE_DB_URL;
  const apiUrl = process.env.TEST_SUPABASE_URL ?? "";
  if (process.env.E2E_DISPOSABLE_DATABASE !== "1") {
    throw new Error(
      "Inbox acceptance projection drain requires E2E_DISPOSABLE_DATABASE=1.",
    );
  }
  if (databaseUrl !== ACCEPTANCE_DATABASE_URL) {
    throw new Error(
      "Inbox acceptance projection drain requires the exact disposable loopback database URL.",
    );
  }
  assertDisposableE2EDatabaseEnvironment(apiUrl, {
    ...process.env,
    E2E_CI_SUPABASE_DB_URL: databaseUrl,
  });

  const client = new Client({ connectionString: databaseUrl, ssl: false });
  await client.connect();
  try {
    const identity = await client.query<{ marker: string | null }>(
      "SELECT marker FROM install_fixture.identity LIMIT 1",
    );
    if (identity.rows[0]?.marker !== ACCEPTANCE_DATABASE_MARKER) {
      throw new Error(
        "Inbox acceptance projection drain database identity marker mismatch.",
      );
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  return client;
}

/**
 * Read the permanent-DNC rows before any source delete. A DNC update is an
 * intentional compliance lock: the properties trigger rejects both mutation
 * and deletion, and deleting a linked contact would make PostgreSQL attempt
 * the same forbidden property update through ON DELETE SET NULL. Acceptance
 * cleanup therefore retains those exact rows and removes only the ordinary
 * fixture rows around them.
 */
async function readCleanupProtection(
  admin: SupabaseClient<Database>,
  orgId: string,
): Promise<CleanupProtection> {
  const { data: lockedProperties, error: lockedPropertiesError } = await admin
    .from("properties")
    .select("id,homeowner_contact_id,agent_contact_id")
    .eq("org_id", orgId)
    .eq("is_dnc_locked", true);
  if (lockedPropertiesError) {
    throw new Error(
      `Inbox acceptance cleanup could not inspect locked properties: ${lockedPropertiesError.message}`,
    );
  }

  const lockedPropertyIds = new Set(
    (lockedProperties ?? []).map((row) => row.id),
  );
  const retainedContactIds = new Set(
    (lockedProperties ?? [])
      .flatMap((row) => [row.homeowner_contact_id, row.agent_contact_id])
      .filter((id): id is string => typeof id === "string"),
  );

  const { data: contacts, error: contactsError } = await admin
    .from("contacts")
    .select("id,do_not_contact")
    .eq("org_id", orgId);
  if (contactsError) {
    throw new Error(
      `Inbox acceptance cleanup could not inspect DNC contacts: ${contactsError.message}`,
    );
  }
  for (const contact of contacts ?? []) {
    if (contact.do_not_contact) retainedContactIds.add(contact.id);
  }

  const { data: retainedProperties, error: leadEventsError } = await admin
    .from("lead_events")
    .select("property_id")
    .eq("org_id", orgId);
  if (leadEventsError) {
    throw new Error(
      `Inbox acceptance cleanup could not inspect lead-event property references: ${leadEventsError.message}`,
    );
  }
  const retainedPropertyIds = new Set(
    (retainedProperties ?? [])
      .map((row) => row.property_id)
      .filter((id): id is string => typeof id === "string"),
  );

  return { lockedPropertyIds, retainedContactIds, retainedPropertyIds };
}

function addIdExclusion<T extends { not: (column: string, operator: string, value: string) => T }>(
  query: T,
  ids: Set<string>,
): T {
  return ids.size === 0 ? query : query.not("id", "in", `(${[...ids].join(",")})`);
}

function isRetryableSupabaseTransportError(error: unknown): boolean {
  return error instanceof Error && /fetch failed|network|socket/i.test(error.message);
}

async function retrySupabaseCleanup<T>(label: string, operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isRetryableSupabaseTransportError(error) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
      process.stdout.write(`${JSON.stringify({
        type: "acceptance_cleanup_retry",
        operation: label,
        attempt: attempt + 2,
      })}\n`);
    }
  }
  throw new Error(`unreachable cleanup retry state for ${label}`);
}

/**
 * DNC-aware equivalent of deleteOrgScopedFixtureRows. It deliberately uses
 * the same ordinary source deletes and leaves all locked properties and
 * their compliance contacts untouched. No trigger/session_replication_role
 * bypass is available here.
 */
async function deleteDncAwareFixtureRows(
  admin: SupabaseClient<Database>,
  orgId: string,
  protection: CleanupProtection,
): Promise<Set<string>> {
  for (const table of ["messages", "notifications"] as const) {
    const { error } = await admin.from(table).delete().eq("org_id", orgId);
    if (error) {
      throw new Error(
        `Inbox acceptance DNC-aware cleanup failed to clear ${table}: ${error.message}`,
      );
    }
  }

  const retainedPropertyIds = new Set(
    protection.retainedPropertyIds,
  );
  for (const id of protection.lockedPropertyIds) retainedPropertyIds.add(id);

  // Only unlocked properties are eligible for the ordinary unlink. Locked
  // DNC properties must retain their relationship and audit state.
  const { error: unlinkError } = await admin
    .from("properties")
    .update({ homeowner_contact_id: null, agent_contact_id: null })
    .eq("org_id", orgId)
    .eq("is_dnc_locked", false);
  if (unlinkError) {
    throw new Error(
      `Inbox acceptance DNC-aware cleanup failed to unlink unlocked properties: ${unlinkError.message}`,
    );
  }

  let contactsQuery = admin.from("contacts").delete().eq("org_id", orgId);
  contactsQuery = addIdExclusion(contactsQuery, protection.retainedContactIds);
  const { error: contactsError } = await contactsQuery;
  if (contactsError) {
    throw new Error(
      `Inbox acceptance DNC-aware cleanup failed to clear ordinary contacts: ${contactsError.message}`,
    );
  }

  // Keep the exclusion local. Encoding every append-only lead-event property
  // id in one PostgREST `not.in` URL can exceed the gateway's request limit
  // and produce a misleading empty-message 502 during teardown.
  const { data: candidateProperties, error: candidatePropertiesError } =
    await admin
      .from("properties")
      .select("id")
      .eq("org_id", orgId)
      .eq("is_dnc_locked", false);
  if (candidatePropertiesError) {
    throw new Error(
      `Inbox acceptance DNC-aware cleanup failed to list ordinary properties: ${candidatePropertiesError.message}`,
    );
  }
  const retained = new Set(retainedPropertyIds);
  const deletablePropertyIds = (candidateProperties ?? [])
    .map((row) => row.id)
    .filter((id) => !retained.has(id));
  for (let offset = 0; offset < deletablePropertyIds.length; offset += 50) {
    const { error: propertiesError } = await admin
      .from("properties")
      .delete()
      .eq("org_id", orgId)
      .eq("is_dnc_locked", false)
      .in("id", deletablePropertyIds.slice(offset, offset + 50));
    if (propertiesError) {
      throw new Error(
        `Inbox acceptance DNC-aware cleanup failed to clear ordinary properties: ${propertiesError.message}`,
      );
    }
  }
  return retainedPropertyIds;
}

/**
 * Remove only review records owned by the acceptance organization before
 * deleting their source messages. The review migration intentionally keeps
 * source_inbound_message_id as a non-cascading FK, so an ordinary message
 * delete must be preceded by this exact org-scoped cleanup. The migration
 * grants service_role SELECT only, so this uses the already identity-checked
 * postgres probe rather than widening production table grants. Read the IDs
 * first and compare another-org counts inside the same transaction; a
 * permission or identity failure must stop cleanup before source rows move.
 */
async function deleteAcceptanceDispositionReviews(
  probe: Client,
  orgId: string,
): Promise<void> {
  await probe.query("BEGIN");
  try {
    const reviews = await probe.query<{ id: string; source_inbound_message_id: string }>(
      `
        SELECT id, source_inbound_message_id
          FROM public.ai_disposition_reviews
         WHERE org_id = $1::uuid
      `,
      [orgId],
    );
    if (reviews.rowCount === 0) {
      await probe.query("COMMIT");
      return;
    }

    const otherBefore = await probe.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
          FROM public.ai_disposition_reviews
         WHERE org_id <> $1::uuid
      `,
      [orgId],
    );
    await probe.query(
      `
        DELETE FROM public.ai_disposition_reviews
         WHERE org_id = $1::uuid
      `,
      [orgId],
    );
    const remainingOwned = await probe.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
          FROM public.ai_disposition_reviews
         WHERE org_id = $1::uuid
      `,
      [orgId],
    );
    const otherAfter = await probe.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
          FROM public.ai_disposition_reviews
         WHERE org_id <> $1::uuid
      `,
      [orgId],
    );
    if (
      Number(remainingOwned.rows[0]?.count ?? "0") !== 0 ||
      otherAfter.rows[0]?.count !== otherBefore.rows[0]?.count
    ) {
      throw new Error(
        `Inbox acceptance cleanup could not verify org-scoped disposition review cleanup for ${orgId}.`,
      );
    }
    await probe.query("COMMIT");
  } catch (error) {
    await probe.query("ROLLBACK").catch(() => undefined);
    throw new Error(
      `Inbox acceptance cleanup could not clear owned disposition reviews: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Saved-action versions are intentionally immutable in normal operation, so a
 * disposable acceptance reset cannot use an ordinary DELETE against their
 * trigger-protected table. The probe is already bound to the marked local
 * fixture; disable that trigger only inside this rollback-scoped cleanup
 * transaction, delete this run's org rows, restore the trigger, and prove
 * another org was unchanged. This path is test-fixture cleanup only and is
 * never reachable from an application request or production installer.
 */
async function deleteAcceptanceSavedActions(
  probe: Client,
  orgId: string,
): Promise<void> {
  await probe.query("BEGIN");
  let triggerDisabled = false;
  try {
    const otherBefore = await probe.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
          FROM inbox_saved_actions.definitions
         WHERE org_id <> $1::uuid
      `,
      [orgId],
    );
    await probe.query(
      "ALTER TABLE inbox_saved_actions.definitions DISABLE TRIGGER immutable_saved_action_version",
    );
    triggerDisabled = true;
    await probe.query(
      `DELETE FROM inbox_saved_actions.definitions WHERE org_id = $1::uuid`,
      [orgId],
    );
    const remainingOwned = await probe.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
          FROM inbox_saved_actions.definitions
         WHERE org_id = $1::uuid
      `,
      [orgId],
    );
    const otherAfter = await probe.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
          FROM inbox_saved_actions.definitions
         WHERE org_id <> $1::uuid
      `,
      [orgId],
    );
    if (
      Number(remainingOwned.rows[0]?.count ?? "0") !== 0 ||
      otherAfter.rows[0]?.count !== otherBefore.rows[0]?.count
    ) {
      throw new Error(
        `saved-action cleanup changed owned/foreign rows unexpectedly for ${orgId}.`,
      );
    }
    await probe.query(
      "ALTER TABLE inbox_saved_actions.definitions ENABLE TRIGGER immutable_saved_action_version",
    );
    triggerDisabled = false;
    await probe.query("COMMIT");
  } catch (error) {
    if (triggerDisabled) {
      await probe
        .query(
          "ALTER TABLE inbox_saved_actions.definitions ENABLE TRIGGER immutable_saved_action_version",
        )
        .catch(() => undefined);
    }
    await probe.query("ROLLBACK").catch(() => undefined);
    throw new Error(
      `Inbox acceptance cleanup could not clear saved actions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function countCleanableRows(
  admin: SupabaseClient<Database>,
  orgId: string,
  retainedPropertyIds: Set<string>,
  retainedContactIds: Set<string>,
): Promise<number> {
  let total = 0;
  for (const table of ["messages", "notifications"] as const) {
    const { count, error } = await admin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("org_id", orgId);
    if (error) throw new Error(`Inbox acceptance cleanup could not count ${table}: ${error.message}`);
    total += count ?? 0;
  }

  let contactsQuery = admin
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId);
  contactsQuery = addIdExclusion(contactsQuery, retainedContactIds);
  const { count: contactsCount, error: contactsError } = await contactsQuery;
  if (contactsError) throw new Error(`Inbox acceptance cleanup could not count ordinary contacts: ${contactsError.message}`);
  total += contactsCount ?? 0;

  const { data: propertyRows, error: propertiesError } = await admin
    .from("properties")
    .select("id")
    .eq("org_id", orgId)
    .eq("is_dnc_locked", false);
  if (propertiesError) throw new Error(`Inbox acceptance cleanup could not list ordinary properties: ${propertiesError.message}`);
  const retained = new Set(retainedPropertyIds);
  return total + (propertyRows ?? []).filter((row) => !retained.has(row.id)).length;
}

/**
 * Wait for one fixture target to be represented by the current projection
 * generation before opening a browser workset. Canonical inserts enqueue the
 * projection asynchronously, so a seed helper returning only after its
 * source INSERT commits is not enough to make a subsequent workset include
 * that target. This is a read-only probe; it never refreshes a mounted
 * browser scope and therefore preserves the arrival test's explicit-refresh
 * contract.
 */
export async function waitForAcceptanceProjectionTarget(
  target: AcceptanceProjectionTarget,
  orgId: string = DEFAULT_ORG_ID,
): Promise<void> {
  const probe = await openProjectionProbe();
  try {
    for (let attempt = 0; attempt < DRAIN_ATTEMPTS; attempt += 1) {
      const result = target.kind === "known_conversation"
        ? await probe.query<{ ready: boolean }>(
            `
              SELECT EXISTS (
                SELECT 1
                  FROM inbox_maintained.rows m
                  JOIN inbox_message_capture.dirty d
                    ON d.org_id = m.org_id
                   AND d.target_kind = m.target_kind
                   AND d.target_id = m.target_id
                  JOIN inbox_bridge.summaries s
                    ON s.org_id = m.org_id
                   AND s.target_kind = m.target_kind
                   AND s.target_id = m.target_id
                  JOIN inbox_bridge.filter_rows f
                    ON f.org_id = m.org_id
                   AND f.target_kind = m.target_kind
                   AND f.target_id = m.target_id
                 WHERE m.org_id = $1::uuid
                   AND m.target_kind = 'known_conversation'
                   AND m.target_id = $2::uuid
                   AND (m.summary->>'exists') = 'true'
                   AND d.generation = m.source_generation
                   AND s.projection_revision = m.revision
                   AND f.revision = m.revision
                   AND s.unread IS NOT DISTINCT FROM $3::boolean
                   AND f.unread IS NOT DISTINCT FROM $3::boolean
              ) AS ready
            `,
            [orgId, target.id, target.unread],
          )
        : await probe.query<{ ready: boolean }>(
            `
              SELECT EXISTS (
                SELECT 1
                  FROM inbox_maintained.rows m
                  JOIN inbox_message_capture.dirty d
                    ON d.org_id = m.org_id
                   AND d.target_kind = m.target_kind
                   AND d.target_id = m.target_id
                  JOIN inbox_message_capture.sender_groups g
                    ON g.org_id = m.org_id
                   AND g.sender_group_id = m.target_id
                  JOIN inbox_bridge.summaries s
                    ON s.org_id = m.org_id
                   AND s.target_kind = m.target_kind
                   AND s.target_id = m.target_id
                  JOIN inbox_bridge.filter_rows f
                    ON f.org_id = m.org_id
                   AND f.target_kind = m.target_kind
                   AND f.target_id = m.target_id
                 WHERE m.org_id = $1::uuid
                   AND m.target_kind = 'unknown_sender'
                   AND g.raw_sender = $2::text
                   AND (m.summary->>'exists') = 'true'
                   AND d.generation = m.source_generation
                   AND s.projection_revision = m.revision
                   AND f.revision = m.revision
                   AND ${target.dismissed ? "s.visible_dismissed AND f.unknown_dismissed" : "s.visible_active AND f.unknown_active"}
              ) AS ready
            `,
            [orgId, target.rawSender],
          );
      if (result.rows[0]?.ready === true) return;
      if (attempt + 1 < DRAIN_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, DRAIN_INTERVAL_MS));
      }
    }
  } finally {
    await probe.end();
  }

  const label = target.kind === "known_conversation"
    ? `${target.kind}:${target.id}`
    : `${target.kind}:${target.rawSender}`;
  throw new Error(
    `Acceptance fixture projection did not publish ${label} within ${(DRAIN_ATTEMPTS * DRAIN_INTERVAL_MS) / 1000}s.`,
  );
}

/**
 * Delete only the acceptance org through ordinary source-table DELETEs, then
 * wait for the real projection worker to publish deletion tombstones. This
 * intentionally refuses to call resetTenantTables(): its TRUNCATE bypasses
 * the capture triggers and can leave duplicate visible rows between runs.
 */
export async function resetAcceptanceFixture(
  admin: SupabaseClient<Database>,
  orgId: string = DEFAULT_ORG_ID,
): Promise<void> {
  if (orgId !== DEFAULT_ORG_ID) {
    throw new Error(
      "Inbox acceptance cleanup only permits the checked-in disposable acceptance organization.",
    );
  }
  // Verify target identity before the first mutating Supabase request. A
  // misbound read probe must never follow a destructive cleanup call.
  const probe = await openProjectionProbe();
  let lastState: AcceptanceProjectionState | undefined;
  try {
    const protection = await readCleanupProtection(admin, orgId);
    if (protection.lockedPropertyIds.size > 0 || protection.retainedContactIds.size > 0) {
      process.stdout.write(`${JSON.stringify({
        type: "acceptance_cleanup_retention",
        reason: "permanent_dnc_compliance_lock",
        retained_property_ids: [...protection.lockedPropertyIds].sort(),
        retained_contact_ids: [...protection.retainedContactIds].sort(),
      })}\n`);
    }
    let retainedPropertyIds = new Set(protection.retainedPropertyIds);
    // ai_disposition_reviews.source_inbound_message_id intentionally does
    // not cascade. Clear this owned child relation before any source-message
    // delete, while the exact fixture identity guard is still in force.
    await deleteAcceptanceSavedActions(probe, orgId);
    await deleteAcceptanceDispositionReviews(probe, orgId);
    if (protection.lockedPropertyIds.size === 0 && protection.retainedContactIds.size === 0) {
      await retrySupabaseCleanup(
        "ordinary_fixture_rows",
        () => deleteOrgScopedFixtureRows(admin, orgId),
      );
    } else {
      retainedPropertyIds = await retrySupabaseCleanup(
        "dnc_aware_fixture_rows",
        () => deleteDncAwareFixtureRows(admin, orgId, protection),
      );
    }

    // Keep the existing org-scoped count as a diagnostic contract. A
    // permanent-DNC row is expected residue; only ordinary rows are required
    // to be gone before the projection drain begins.
    await countOrgScopedFixtureRows(admin, orgId);
    const remaining = await countCleanableRows(
      admin,
      orgId,
      retainedPropertyIds,
      protection.retainedContactIds,
    );
    if (remaining !== 0) {
      throw new Error(
        `Inbox acceptance cleanup left ${remaining} canonical fixture rows for org ${orgId}.`,
      );
    }

    for (let attempt = 0; attempt < DRAIN_ATTEMPTS; attempt += 1) {
      lastState = await readProjectionState(probe, orgId);
      if (isAcceptanceProjectionDrained(lastState)) break;
      if (attempt + 1 < DRAIN_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, DRAIN_INTERVAL_MS));
      }
    }
  } finally {
    await probe.end();
  }

  if (!lastState || !isAcceptanceProjectionDrained(lastState)) {
    throw new Error(
      `Inbox acceptance projection did not drain within ${
        (DRAIN_ATTEMPTS * DRAIN_INTERVAL_MS) / 1000
      }s: ${formatState(lastState ?? { queuePending: true, parentPending: true, safetyPending: true, maintainedRows: -1, summaryRows: -1, filterRows: -1 })}`,
    );
  }

}

/**
 * Remove the per-run acceptance organization after its source rows and
 * projection tombstones have been verified. The owner guard is disabled only
 * inside this rollback-scoped disposable-fixture transaction; production
 * requests never reach this path. Refuse a shared-tenant id or a mismatched
 * organization name before any destructive statement.
 */
export async function deleteAcceptanceOrganization(): Promise<void> {
  const configured = process.env.INBOX_ACCEPTANCE_ORG_ID?.trim();
  if (!configured) return;
  const runSlug = process.env.E2E_RUN_SLUG?.trim();
  if (!runSlug) {
    throw new Error("acceptance cleanup requires the exact E2E run slug");
  }

  const probe = await openProjectionProbe();
  try {
    await probe.query("BEGIN");
    const org = await probe.query<{ name: string }>(
      "SELECT name FROM public.organizations WHERE id = $1::uuid",
      [DEFAULT_ORG_ID],
    );
    if (org.rowCount === 0) {
      await probe.query("COMMIT");
      return;
    }
    if (!org.rows[0]!.name.startsWith("Sandra Inbox Acceptance ")) {
      throw new Error("refusing to delete a non-disposable acceptance organization");
    }

    // The disposable tenant deliberately exercises immutable/DNC and
    // append-only paths. Its final teardown must remove those rows too, but
    // ordinary DELETE is correctly rejected by their production triggers.
    // Disable only user triggers inside this exact marker-bound transaction;
    // foreign-key triggers remain enabled. Delete in a child-first order
    // discovered from the live FK graph so RI still proves the teardown is
    // structurally valid. Whole-database content signatures prove that no
    // foreign tenant row changed.
    type TableMeta = { oid: string; qualified: string; hasOrgId: boolean };
    type ForeignKey = {
      child: string;
      parent: string;
      childColumns: string[];
      parentColumns: string[];
      blocksDelete: boolean;
    };
    const tableResult = await probe.query<TableMeta>(`
      SELECT c.oid::text AS oid,
             format('%I.%I', n.nspname, c.relname) AS qualified,
             EXISTS (
               SELECT 1
                 FROM pg_attribute a
                WHERE a.attrelid = c.oid
                  AND a.attname = 'org_id'
                  AND NOT a.attisdropped
             ) AS "hasOrgId"
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r'
         AND n.nspname NOT LIKE 'pg_%'
         AND n.nspname <> 'information_schema'
    `);
    const tables = new Map(tableResult.rows.map((row) => [row.oid, row]));
    const fkResult = await probe.query<ForeignKey>(`
      SELECT fk.conrelid::text AS child,
             fk.confrelid::text AS parent,
             (fk.confdeltype IN ('a', 'r')) AS "blocksDelete",
             array_agg(format('%I', child_attr.attname) ORDER BY child_key.ord) AS "childColumns",
             array_agg(format('%I', parent_attr.attname) ORDER BY child_key.ord) AS "parentColumns"
        FROM pg_constraint fk
        JOIN pg_class child_table ON child_table.oid = fk.conrelid
        JOIN pg_namespace child_ns ON child_ns.oid = child_table.relnamespace
        JOIN pg_class parent_table ON parent_table.oid = fk.confrelid
        JOIN pg_namespace parent_ns ON parent_ns.oid = parent_table.relnamespace
        JOIN unnest(fk.conkey) WITH ORDINALITY AS child_key(attnum, ord) ON true
        JOIN unnest(fk.confkey) WITH ORDINALITY AS parent_key(attnum, ord)
          ON parent_key.ord = child_key.ord
        JOIN pg_attribute child_attr
          ON child_attr.attrelid = fk.conrelid
         AND child_attr.attnum = child_key.attnum
        JOIN pg_attribute parent_attr
          ON parent_attr.attrelid = fk.confrelid
         AND parent_attr.attnum = parent_key.attnum
       WHERE fk.contype = 'f'
         AND child_table.relkind = 'r'
         AND parent_table.relkind = 'r'
         AND child_ns.nspname NOT LIKE 'pg_%'
         AND parent_ns.nspname NOT LIKE 'pg_%'
         AND child_ns.nspname <> 'information_schema'
         AND parent_ns.nspname <> 'information_schema'
       GROUP BY fk.conrelid, fk.confrelid, fk.confdeltype, fk.oid
    `);
    const foreignKeys = fkResult.rows.filter(
      (fk) => tables.has(fk.child) && tables.has(fk.parent),
    );
    const affected = new Set(
      [...tables.values()]
        .filter((table) => table.hasOrgId)
        .map((table) => table.oid),
    );
    let grew = true;
    while (grew) {
      grew = false;
      for (const fk of foreignKeys) {
        if (affected.has(fk.parent) && !affected.has(fk.child)) {
          affected.add(fk.child);
          grew = true;
        }
      }
    }

    const directFks = foreignKeys.filter(
      (fk) =>
        fk.blocksDelete && affected.has(fk.child) && affected.has(fk.parent),
    );
    const uniqueDirectFks = directFks.filter((fk, index, all) =>
      all.findIndex(
        (candidate) =>
          candidate.child === fk.child && candidate.parent === fk.parent,
      ) === index,
    );
    const indegree = new Map([...affected].map((oid) => [oid, 0]));
    for (const fk of uniqueDirectFks) {
      if (fk.child === fk.parent) continue;
      indegree.set(fk.parent, (indegree.get(fk.parent) ?? 0) + 1);
    }
    const ready = [...indegree]
      .filter(([, degree]) => degree === 0)
      .map(([oid]) => oid);
    const deleteOrder: string[] = [];
    while (ready.length > 0) {
      const oid = ready.shift()!;
      deleteOrder.push(oid);
      for (const parent of uniqueDirectFks
        .filter((fk) => fk.child === oid && fk.child !== fk.parent)
        .map((fk) => fk.parent)) {
        const degree = (indegree.get(parent) ?? 0) - 1;
        indegree.set(parent, degree);
        if (degree === 0) ready.push(parent);
      }
    }
    // A remaining cycle would be a schema error for a target cleanup. Keep
    // it visible rather than silently broadening a predicate.
    if (deleteOrder.length !== affected.size) {
      throw new Error("acceptance cleanup found a cyclic FK dependency");
    }

    const predicateFor = (
      oid: string,
      alias: string,
      stack = new Set<string>(),
    ): string => {
      const table = tables.get(oid);
      if (!table) return "FALSE";
      if (table.hasOrgId) return `${alias}."org_id" = $1::uuid`;
      if (stack.has(oid)) return "FALSE";
      const nextStack = new Set(stack).add(oid);
      const branches = foreignKeys
        .filter(
          (fk) =>
            fk.blocksDelete && fk.child === oid && affected.has(fk.parent),
        )
        .map((fk, index) => {
          const parentAlias = `${alias}_p${index}`;
          const join = fk.childColumns
            .map(
              (column, columnIndex) =>
                `${alias}.${column} = ${parentAlias}.${fk.parentColumns[columnIndex]}`,
            )
            .join(" AND ");
          return `EXISTS (SELECT 1 FROM ${tables.get(fk.parent)!.qualified} ${parentAlias} WHERE ${join} AND ${predicateFor(fk.parent, parentAlias, nextStack)})`;
        });
      return branches.length > 0 ? `(${branches.join(" OR ")})` : "FALSE";
    };

    for (const oid of deleteOrder) {
      const table = tables.get(oid)!;
      await probe.query(`ALTER TABLE ${table.qualified} DISABLE TRIGGER USER`);
    }
    for (const oid of deleteOrder) {
      const table = tables.get(oid)!;
      await probe.query(
        `DELETE FROM ${table.qualified} AS target WHERE ($1::uuid IS NOT NULL AND ${predicateFor(oid, "target")})`,
        [DEFAULT_ORG_ID],
      );
    }
    await probe.query(
      "DELETE FROM public.organizations WHERE id = $1::uuid",
      [DEFAULT_ORG_ID],
    );
    // A reply-context snapshot has no FK to organizations because it is an
    // immutable projection cache. Remove the exact tenant rows again after
    // the source delete: a queued reply-context write can commit after the
    // ordinary org-scoped tables have drained, and whole-database proof must
    // still see zero residual rows for this run.
    await probe.query(
      "DELETE FROM inbox_reply_context.versions WHERE org_id = $1::uuid",
      [DEFAULT_ORG_ID],
    );

    // Auth users are job-scoped resources rather than tenant rows. Keep the
    // cleanup exact by matching the identity guard's run_slug metadata, then
    // remove only their non-cascading bridge/audit artifacts before the
    // auth.users delete. Cascading auth children (identities, sessions, and
    // memberships) are left to their declared foreign keys.
    await probe.query(
      `CREATE TEMP TABLE acceptance_run_users ON COMMIT DROP AS
         SELECT id
           FROM auth.users
          WHERE raw_app_meta_data->>'run_slug' = $1::text
            AND raw_app_meta_data->>'owner' = 'github-actions'
            AND raw_app_meta_data->>'purpose' = 'ci-e2e'`,
      [runSlug],
    );
    await probe.query(
      `DELETE FROM auth.audit_log_entries audit
       WHERE audit.payload::text LIKE '%' || $1::text || '%'
          OR EXISTS (
               SELECT 1
                 FROM acceptance_run_users users
                WHERE audit.payload::text LIKE '%' || users.id::text || '%'
             )`,
      [runSlug],
    );
    await probe.query(
      `DELETE FROM auth.users users
       USING acceptance_run_users run_users
       WHERE users.id = run_users.id`,
    );
    // Deleting auth.users cascades memberships and sessions; both production
    // triggers advance/create an access epoch. Remove the exact run users'
    // epochs only after those cascades have completed, otherwise teardown
    // would leave one orphaned epoch behind and fail whole-database proof.
    await probe.query(
      `DELETE FROM inbox_bridge.access_epochs epochs
        USING acceptance_run_users users
       WHERE epochs.user_id = users.id`,
    );
    for (const oid of deleteOrder) {
      const table = tables.get(oid)!;
      await probe.query(`ALTER TABLE ${table.qualified} ENABLE TRIGGER USER`);
    }
    await probe.query("COMMIT");
  } catch (error) {
    await probe.query("ROLLBACK").catch(() => undefined);
    throw new Error(
      `Inbox acceptance cleanup could not remove disposable organization: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await probe.end();
  }
}
