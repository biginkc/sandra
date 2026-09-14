import { createClient } from "@supabase/supabase-js";
import { fileURLToPath } from "node:url";

export const LIVE_SALES_ORG_ID = "00000000-0000-0000-0000-000000000bbb";

export const READ_ONLY_ORG_ESIGN_COLUMNS = Object.freeze([
  "org_id",
  "provider",
  "api_key_last_four",
  "sending_enabled",
  "test_mode",
  "disconnect_pending_at",
]);

export function classifyCanaryPreflight({
  dedicatedOrgId,
  dedicatedIntegration,
  integrationReadUnavailable,
  readColumns = READ_ONLY_ORG_ESIGN_COLUMNS,
  liveSalesOrgId = LIVE_SALES_ORG_ID,
}) {
  if (!dedicatedOrgId) {
    return { status: "BLOCKED", reason: "missing PROD_CANARY_ESIGN_ORG_ID" };
  }

  if (dedicatedOrgId === liveSalesOrgId) {
    return {
      status: "BLOCKED",
      reason: "dedicated org is the live sales org",
    };
  }

  if (integrationReadUnavailable) {
    return {
      status: "BLOCKED",
      reason: "dedicated integration settings are unavailable",
    };
  }

  if (!dedicatedIntegration) {
    return {
      status: "BLOCKED",
      reason: "dedicated org is not connected",
    };
  }

  for (const column of readColumns) {
    if (!(column in dedicatedIntegration)) {
      return {
        status: "BLOCKED",
        reason: "dedicated integration settings are unavailable",
      };
    }
  }

  if (dedicatedIntegration.provider !== "dropbox_sign") {
    return {
      status: "BLOCKED",
      reason: "dedicated integration provider is not dropbox_sign",
    };
  }

  if (dedicatedIntegration.org_id !== dedicatedOrgId || !dedicatedIntegration.api_key_last_four || dedicatedIntegration.disconnect_pending_at) {
    return { status: "BLOCKED", reason: "dedicated org is not connected" };
  }

  if (dedicatedIntegration.test_mode) {
    return {
      status: "BLOCKED",
      reason: "dedicated integration is in test mode",
    };
  }

  if (typeof dedicatedIntegration.sending_enabled !== "boolean") {
    return {
      status: "BLOCKED",
      reason: "dedicated integration settings are unavailable",
    };
  }

  if (!dedicatedIntegration.sending_enabled) {
    return {
      status: "BLOCKED",
      reason: "sending is disabled for dedicated integration",
    };
  }

  return {
    status: "READY",
    reason: "dedicated integration is connected and eligible",
  };
}

function getSupabaseClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
    );
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function runPreflight({
  dedicatedOrgId = process.env.PROD_CANARY_ESIGN_ORG_ID,
  createClientFn = getSupabaseClient,
} = {}) {
  if (!dedicatedOrgId || dedicatedOrgId === LIVE_SALES_ORG_ID) {
    return classifyCanaryPreflight({ dedicatedOrgId, dedicatedIntegration: null });
  }

  try {
    const supabase = createClientFn();
    const { data, error } = await supabase
      .from("org_esign_integrations")
      .select(READ_ONLY_ORG_ESIGN_COLUMNS.join(","))
      .eq("org_id", dedicatedOrgId)
      .eq("provider", "dropbox_sign")
      .maybeSingle();

    if (error) {
      return classifyCanaryPreflight({
        dedicatedOrgId,
        dedicatedIntegration: null,
        integrationReadUnavailable: true,
      });
    }

    return classifyCanaryPreflight({
      dedicatedOrgId,
      dedicatedIntegration: data,
      integrationReadUnavailable: false,
    });
  } catch (error) {
    return classifyCanaryPreflight({
      dedicatedOrgId,
      dedicatedIntegration: null,
      integrationReadUnavailable: true,
      readError: String(error),
    });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPreflight()
    .then((result) => {
      console.log(JSON.stringify(result));
      if (result.status !== "READY") {
        process.exitCode = 1;
      }
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
