import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://copflsklaefwzipsrjqz.supabase.co";
const ANON_KEY = process.env.PROD_ANON_KEY ?? "";
const EMAIL = process.env.VERIFY_EMAIL ?? "";
const PASSWORD = process.env.VERIFY_PASSWORD ?? "";

if (!ANON_KEY) {
  console.error("Set PROD_ANON_KEY env var to the prod anon key.");
  process.exit(2);
}
if (!EMAIL || !PASSWORD) {
  console.error("Set VERIFY_EMAIL and VERIFY_PASSWORD for a real allowed prod user.");
  process.exit(2);
}

async function main() {
  const supabase = createClient(SUPABASE_URL, ANON_KEY);
  const { error: authErr } = await supabase.auth.signInWithPassword({
    email: EMAIL,
    password: PASSWORD,
  });
  if (authErr) {
    console.error("auth failed:", authErr);
    process.exit(1);
  }

  const { data, error } = await supabase.rpc("dashboard_summary");
  if (error) {
    console.log("RPC error:", JSON.stringify(error, null, 2));
  } else {
    const obj = data as Record<string, unknown>;
    console.log("RPC ok. keys:", Object.keys(obj).join(","));
    console.log(
      "values:",
      JSON.stringify({
        total_leads: obj.total_leads,
        new_this_week: obj.new_this_week,
        not_in_drip: obj.not_in_drip,
        hot_leads: obj.hot_leads,
        needs_attention: obj.needs_attention,
      }),
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
