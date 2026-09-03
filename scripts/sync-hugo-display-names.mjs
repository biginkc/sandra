#!/usr/bin/env node

import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { createClient } from "@supabase/supabase-js";

export const APPLY_ARM = "SYNC_REVIEWED_HUGO_NAMES";
export const HUGO_PROJECT_REF = "fwmdgskpdbacjqjefjqm";
export const SANDRA_PROJECT_REF = "copflsklaefwzipsrjqz";
export const REVIEWED_DISPLAY_NAME_OVERRIDES = Object.freeze({
  "gretchen@bmhgroupkc.com": "Gretchen",
  "info@bmhgroupkc.com": "BMH Group Info",
  "sop-va@bmhgroupkc.com": "SOP VA",
});

export function parseNameSyncArgs(argv) {
  const result = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--env") {
      const value = argv[index + 1];
      if (!value) throw new Error("Missing value for --env");
      result.env = value;
      index += 1;
    } else if (token === `--apply=${APPLY_ARM}`) {
      result.apply = true;
    } else {
      throw new Error(`Unknown or unarmed argument: ${token}`);
    }
  }
  return result;
}

function clean(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizedEmail(value) {
  return clean(value)?.toLowerCase() ?? null;
}

export function buildReviewedOverrideGrants(sandraUsers, activeUserIds) {
  const activeIds = new Set(activeUserIds);
  return sandraUsers.flatMap((user) => {
    const email = normalizedEmail(user.email);
    const displayName = email
      ? REVIEWED_DISPLAY_NAME_OVERRIDES[email]
      : null;
    if (!email || !displayName || !activeIds.has(user.id)) return [];
    return [
      {
        user_id: `reviewed:${email}`,
        app_id: "sandra",
        app_user_id: user.id,
        desired_status: "active",
        access_ends_at: null,
        profiles: { email, display_name: displayName, status: "active" },
      },
    ];
  });
}

export function buildNameSyncPlan(grants, sandraUsers) {
  const usersById = new Map(sandraUsers.map((user) => [user.id, user]));
  const usersByEmail = new Map();
  for (const user of sandraUsers) {
    const email = normalizedEmail(user.email);
    if (!email) continue;
    const matches = usersByEmail.get(email) ?? [];
    matches.push(user);
    usersByEmail.set(email, matches);
  }
  const updates = [];
  const unresolvedGrantIds = [];
  let identifierMismatchCount = 0;
  for (const grant of grants) {
    const profile = Array.isArray(grant.profiles)
      ? grant.profiles[0]
      : grant.profiles;
    const appUserId = clean(grant.app_user_id);
    const displayName = clean(profile?.display_name);
    const email = normalizedEmail(profile?.email);
    if (
      grant.app_id !== "sandra" ||
      grant.desired_status !== "active" ||
      profile?.status !== "active" ||
      !displayName ||
      !email ||
      (grant.access_ends_at && new Date(grant.access_ends_at) <= new Date())
    ) {
      continue;
    }
    const idUser = appUserId ? usersById.get(appUserId) : null;
    if (idUser && normalizedEmail(idUser.email) !== email) {
      throw new Error("An active Hugo grant points to a different Sandra identity.");
    }
    const emailMatches = usersByEmail.get(email) ?? [];
    if (emailMatches.length > 1) {
      throw new Error("An active Hugo name maps to multiple Sandra identities.");
    }
    const user = emailMatches[0];
    if (!user) {
      unresolvedGrantIds.push(grant.user_id);
      continue;
    }
    if (appUserId !== user.id) identifierMismatchCount += 1;
    if (clean(user.app_metadata?.display_name) !== displayName) {
      updates.push({
        userId: user.id,
        displayName,
        appMetadata: { ...(user.app_metadata ?? {}), display_name: displayName },
      });
    }
  }
  updates.sort((left, right) => left.userId.localeCompare(right.userId));
  unresolvedGrantIds.sort();
  const sealedHash = createHash("sha256")
    .update(
      JSON.stringify({
        updates: updates.map((update) => [update.userId, update.displayName]),
        unresolvedGrantIds,
        identifierMismatchCount,
      }),
    )
    .digest("hex");
  return {
    updates,
    unresolvedCount: unresolvedGrantIds.length,
    identifierMismatchCount,
    sealedHash,
  };
}

async function listAllUsers(client) {
  const users = [];
  for (let page = 1; page <= 25; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({
      page,
      perPage: 200,
    });
    if (error) throw error;
    users.push(...(data?.users ?? []));
    if ((data?.users ?? []).length < 200) return users;
  }
  throw new Error("Sandra identity inventory exceeded the supported limit.");
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is missing.`);
  return value;
}

export function assertSupabaseProjectUrl(value, expectedRef, label) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== `${expectedRef}.supabase.co` ||
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error(`Refusing an unexpected ${label} project URL.`);
  }
  return url.origin;
}

async function main() {
  const args = parseNameSyncArgs(process.argv.slice(2));
  if (args.env) process.loadEnvFile(path.resolve(args.env));
  const hugoUrl = assertSupabaseProjectUrl(
    requiredEnv("HUGO_SUPABASE_URL"),
    HUGO_PROJECT_REF,
    "Hugo",
  );
  const sandraUrl = assertSupabaseProjectUrl(
    requiredEnv("NEXT_PUBLIC_SUPABASE_URL"),
    SANDRA_PROJECT_REF,
    "Sandra",
  );
  const hugo = createClient(
    hugoUrl,
    requiredEnv("HUGO_SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const sandra = createClient(
    sandraUrl,
    requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const [
    { data: grants, error },
    sandraUsers,
    { data: memberships, error: membershipsError },
  ] = await Promise.all([
    hugo
      .from("app_grants")
      .select("user_id, app_id, app_user_id, desired_status, access_ends_at")
      .eq("app_id", "sandra"),
    listAllUsers(sandra),
    sandra
      .from("memberships")
      .select("user_id, access_status, access_expires_at, deletion_prepared_at")
      .eq("access_status", "active")
      .is("deletion_prepared_at", null),
  ]);
  if (error) throw error;
  if (membershipsError) throw membershipsError;
  const hugoUserIds = [...new Set((grants ?? []).map((grant) => grant.user_id))];
  const { data: profiles, error: profilesError } = hugoUserIds.length
    ? await hugo
        .from("profiles")
        .select("id, email, display_name, status")
        .in("id", hugoUserIds)
    : { data: [], error: null };
  if (profilesError) throw profilesError;
  const profilesById = new Map(
    (profiles ?? []).map((profile) => [profile.id, profile]),
  );
  const activeUserIds = (memberships ?? [])
    .filter(
      (membership) =>
        !membership.access_expires_at ||
        new Date(membership.access_expires_at) > new Date(),
    )
    .map((membership) => membership.user_id);
  const plan = buildNameSyncPlan(
    (grants ?? []).map((grant) => ({
      ...grant,
      profiles: profilesById.get(grant.user_id) ?? null,
    })).concat(buildReviewedOverrideGrants(sandraUsers, activeUserIds)),
    sandraUsers,
  );
  if (args.apply) {
    for (const update of plan.updates) {
      const { error: updateError } = await sandra.auth.admin.updateUserById(
        update.userId,
        { app_metadata: update.appMetadata },
      );
      if (updateError) throw updateError;
    }
  }
  process.stdout.write(
    `${JSON.stringify({ mode: args.apply ? "APPLIED" : "DRY_RUN", updateCount: plan.updates.length, unresolvedCount: plan.unresolvedCount, identifierMismatchCount: plan.identifierMismatchCount, sealedHash: plan.sealedHash })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
