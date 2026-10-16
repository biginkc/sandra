#!/usr/bin/env tsx
/**
 * Seed the four Jarrad-approved (2026-10-07) reply texts into an org's
 * Templates library, UNAPPROVED. Dry run is the default; pass --apply to write.
 * Re-running is safe: texts already in the library are skipped.
 *
 *   npx tsx scripts/messages-v2/seed-reply-templates.ts            # all orgs, dry run
 *   npx tsx scripts/messages-v2/seed-reply-templates.ts --apply
 *   npx tsx scripts/messages-v2/seed-reply-templates.ts --apply --org <org-uuid>
 *
 * After seeding, an owner opens Templates, clicks Approve on each text, and
 * maps it under "Automatic replies". Nothing sends before that.
 */
import { seedApprovedReplyTemplates } from "../../src/lib/ai-responder/seed-reply-templates";
import { createAdminClient } from "../../src/lib/supabase/admin";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const orgFlag = args.indexOf("--org");
  const onlyOrg = orgFlag >= 0 ? args[orgFlag + 1] : null;
  if (orgFlag >= 0 && !onlyOrg) throw new Error("--org needs an organization id");

  const supabase = createAdminClient();
  const query = supabase.from("organizations").select("id");
  const { data: orgs, error } = await (onlyOrg ? query.eq("id", onlyOrg) : query);
  if (error) throw new Error(`organizations lookup: ${error.message}`);
  if (!orgs?.length) throw new Error(onlyOrg ? `organization ${onlyOrg} not found` : "no organizations found");

  for (const org of orgs) {
    const result = await seedApprovedReplyTemplates(supabase, org.id, { dryRun: !apply });
    console.log(
      `${apply ? "applied" : "dry run"} org=${org.id} created=[${result.created.join(",")}] alreadyPresent=[${result.alreadyPresent.join(",")}]`,
    );
  }
  if (!apply) console.log("Dry run only. Re-run with --apply to write.");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
