import { createClient } from "@supabase/supabase-js";
import { createGitHubRunEnvironment, ensureE2ERunEnvironment, identityForPrincipal } from "../src/lib/supabase/e2e-identity-guard";

async function main() {
if (process.env.TEST_SUPABASE_URL !== "http://127.0.0.1:54321") throw new Error("Local target required");
const client = createClient(process.env.TEST_SUPABASE_URL, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
const { data: users, error: inventoryError } = await client.auth.admin.listUsers();
if (inventoryError || users.users.length) throw new Error("Disposable Auth baseline must be empty");
const identity = identityForPrincipal(process.env.GITHUB_ACTIONS === "true" ? createGitHubRunEnvironment() : ensureE2ERunEnvironment());
const { data, error } = await client.auth.admin.createUser({ email: identity.email, password: identity.password, email_confirm: true, app_metadata: identity.appMetadata });
if (error || !data.user) throw new Error("Cannot create disposable owner");
const { error: membershipError } = await client.from("memberships").insert({ user_id: data.user.id, org_id: "00000000-0000-0000-0000-000000000bbb", role: "owner" });
if (membershipError) throw new Error(`Cannot provision disposable owner membership: ${membershipError.message}`);
console.log("Namespaced disposable owner provisioned; destroyed with the owned database after tests.");
}
main().catch((error: Error) => { console.error(error.message); process.exitCode = 1; });
