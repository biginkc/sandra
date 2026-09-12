export {};

/*
 * P13 launch operator. This is a dry-run planner unless both --execute and
 * --admit are supplied. It deliberately does not enable My Leads; the apply
 * RPC only initializes the admitted cohort while the gate remains disabled.
 */

type Mode = "preview" | "apply" | "rollback";

type Args = {
  mode: Mode;
  orgId?: string;
  memberId?: string;
  cohortId?: string;
  fingerprint?: string;
  settingsRevision?: number;
  idempotencyKey?: string;
  admit: boolean;
  execute: boolean;
};

function usage(): string {
  return `My Leads launch planner (dry-run by default)

Preview:
  node --import tsx scripts/my-leads-launch.ts --preview --org-id ORG --member-id MEMBER

Apply or rollback plans:
  ... --apply --org-id ORG --member-id MEMBER --cohort-id COHORT \
      --fingerprint SHA256 --settings-revision N --idempotency-key UUID
  ... --rollback --org-id ORG --cohort-id COHORT --idempotency-key UUID

Execution requires both --execute and --admit. The apply RPC leaves the rollout
gate disabled; enabling it is a separate admitted operation.
`;
}

function value(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

function parse(argv: string[]): Args {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(usage());
    process.exit(0);
  }
  const modes = (["--preview", "--apply", "--rollback"] as const).filter((flag) =>
    argv.includes(flag),
  );
  if (modes.length > 1) throw new Error("Choose exactly one of --preview, --apply, or --rollback.");
  const mode: Mode = modes[0]?.slice(2) as Mode | undefined ?? "preview";
  const settingsRevisionRaw = value(argv, "--settings-revision");
  const settingsRevision = settingsRevisionRaw === undefined ? undefined : Number(settingsRevisionRaw);
  if (settingsRevision !== undefined && !Number.isSafeInteger(settingsRevision)) {
    throw new Error("--settings-revision must be a safe integer.");
  }
  return {
    mode,
    orgId: value(argv, "--org-id"),
    memberId: value(argv, "--member-id"),
    cohortId: value(argv, "--cohort-id"),
    fingerprint: value(argv, "--fingerprint"),
    settingsRevision,
    idempotencyKey: value(argv, "--idempotency-key"),
    admit: argv.includes("--admit"),
    execute: argv.includes("--execute"),
  };
}

function requireValue(name: string, input: string | undefined): string {
  if (!input) throw new Error(`${name} is required.`);
  return input;
}

function plan(args: Args): Record<string, unknown> {
  if (args.mode === "preview") {
    return {
      mode: args.mode,
      operation: "fn_preview_acquisition_launch",
      readOnly: true,
      orgId: requireValue("--org-id", args.orgId),
      memberId: requireValue("--member-id", args.memberId),
    };
  }
  if (args.mode === "apply") {
    return {
      mode: args.mode,
      operation: "fn_apply_acquisition_launch",
      readOnly: false,
      gateChange: "none",
      orgId: requireValue("--org-id", args.orgId),
      memberId: requireValue("--member-id", args.memberId),
      cohortId: requireValue("--cohort-id", args.cohortId),
      fingerprint: requireValue("--fingerprint", args.fingerprint),
      settingsRevision: args.settingsRevision ?? (() => { throw new Error("--settings-revision is required."); })(),
      idempotencyKey: requireValue("--idempotency-key", args.idempotencyKey),
    };
  }
  return {
    mode: args.mode,
    operation: "fn_rollback_acquisition_launch",
    readOnly: false,
    gateChange: "none",
    orgId: requireValue("--org-id", args.orgId),
    cohortId: requireValue("--cohort-id", args.cohortId),
    idempotencyKey: requireValue("--idempotency-key", args.idempotencyKey),
  };
}

async function execute(args: Args, operation: Record<string, unknown>): Promise<void> {
  if (!args.execute || !args.admit) {
    console.log(JSON.stringify({ dryRun: true, ...operation }, null, 2));
    console.log("No database call made. Add both --execute and --admit for an admitted operation.");
    return;
  }
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const accessToken = process.env.MY_LEADS_ACCESS_TOKEN;
  if (!baseUrl || !anonKey || !accessToken) {
    throw new Error(
      "Execution requires NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, and MY_LEADS_ACCESS_TOKEN.",
    );
  }
  const rpcArgs = args.mode === "preview"
    ? { p_org_id: operation.orgId, p_member_id: operation.memberId }
    : args.mode === "apply"
      ? {
          p_org_id: operation.orgId,
          p_member_id: operation.memberId,
          p_cohort_id: operation.cohortId,
          p_preview_fingerprint: operation.fingerprint,
          p_expected_settings_revision: operation.settingsRevision,
          p_idempotency_key: operation.idempotencyKey,
        }
      : {
          p_org_id: operation.orgId,
          p_cohort_id: operation.cohortId,
          p_idempotency_key: operation.idempotencyKey,
        };
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/rest/v1/rpc/${operation.operation}`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(rpcArgs),
  });
  const body = await response.text();
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch {
    result = { response: body };
  }
  console.log(JSON.stringify({ httpStatus: response.status, result }, null, 2));
  if (!response.ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  try {
    const args = parse(process.argv.slice(2));
    const operation = plan(args);
    await execute(args, operation);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${usage()}`);
    process.exitCode = 2;
  }
}

void main();
