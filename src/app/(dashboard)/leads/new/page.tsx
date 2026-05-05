import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { LEAD_SOURCES } from "@/lib/leads/create";
import { createClient } from "@/lib/supabase/server";

import { submitNewLead } from "./actions";

export const metadata = {
  title: "Add a lead · Sandra CRM",
};

const SOURCE_LABELS: Record<string, string> = {
  dealmachine: "DealMachine",
  propstream: "PropStream",
  driving_for_dollars: "Driving for dollars",
  referral: "Referral",
  cold_call: "Cold call",
  sms: "SMS (inbound)",
  web_form: "Web form",
  direct_mail: "Direct mail",
};

// The market dropdown reads from the counties table at runtime per
// phase 02 D-01 — adding a new market is a DB insert, not a code
// change. The fetch happens inside the page component below.

const STATES = ["MO", "KS", "OH", "IL", "AR", "OK", "NE", "IA", "TN", "KY"];

export default async function NewLeadPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; field?: string }>;
}) {
  const params = await searchParams;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return (
      <Page>
        <PageHeader title="Add a lead" description="Sign in required." />
      </Page>
    );
  }

  // Markets list — fetched from the counties table per phase 02 D-01.
  // Sorted by state then name to match the import wizard's order.
  const { data: counties } = await supabase
    .from("counties")
    .select("market")
    .order("state", { ascending: true })
    .order("name", { ascending: true });
  const markets: string[] = (counties ?? []).map((c) => c.market);

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workspace" },
          { label: "Leads", href: "/leads" },
          { label: "Add a lead" },
        ]}
        title="Add a lead"
        description="Manual entry — for leads that came in off-call (callback, walk-in, referral chat). Cold-call leads coming through Enzo will appear automatically via the webhook."
      />

      {params.error ? (
        <div className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border p-3 text-sm">
          {params.error}
        </div>
      ) : null}

      <form action={submitNewLead} className="flex flex-col gap-6">
        {/* Source — required, drives KPI / attribution */}
        <fieldset className="border-border flex flex-col gap-2 rounded-lg border p-4">
          <legend className="text-sm font-semibold">Source</legend>
          <Label htmlFor="source">How did this lead come in?</Label>
          <select
            id="source"
            name="source"
            required
            className="border-input bg-background ring-offset-background flex h-10 w-full rounded-md border px-3 py-2 text-sm"
            defaultValue="cold_call"
          >
            {LEAD_SOURCES.map((s) => (
              <option key={s} value={s}>
                {SOURCE_LABELS[s] ?? s}
              </option>
            ))}
          </select>
        </fieldset>

        {/* Property — address + state required */}
        <fieldset className="border-border flex flex-col gap-3 rounded-lg border p-4">
          <legend className="text-sm font-semibold">Property</legend>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="address">Street address</Label>
            <Input
              id="address"
              name="address"
              required
              placeholder="123 Main St"
              autoComplete="off"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="flex flex-col gap-1.5 md:col-span-2">
              <Label htmlFor="city">City</Label>
              <Input id="city" name="city" placeholder="Kansas City" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="state">State</Label>
              <select
                id="state"
                name="state"
                required
                className="border-input bg-background flex h-10 w-full rounded-md border px-3 py-2 text-sm"
                defaultValue="MO"
              >
                {STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="zip">ZIP</Label>
              <Input id="zip" name="zip" placeholder="64111" inputMode="numeric" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="market">Market</Label>
              <select
                id="market"
                name="market"
                className="border-input bg-background flex h-10 w-full rounded-md border px-3 py-2 text-sm"
                defaultValue=""
              >
                <option value="">— pick a market —</option>
                {markets.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </fieldset>

        {/* Contact — optional but encouraged */}
        <fieldset className="border-border flex flex-col gap-3 rounded-lg border p-4">
          <legend className="text-sm font-semibold">Homeowner contact (optional)</legend>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="first_name">First name</Label>
              <Input id="first_name" name="first_name" autoComplete="off" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="last_name">Last name</Label>
              <Input id="last_name" name="last_name" autoComplete="off" />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="phone_1">Phone</Label>
              <Input
                id="phone_1"
                name="phone_1"
                type="tel"
                placeholder="+18165551234"
                inputMode="tel"
                autoComplete="off"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="owner@example.com"
                autoComplete="off"
              />
            </div>
          </div>
        </fieldset>

        <div className="flex justify-end">
          <Button type="submit">Create lead</Button>
        </div>
      </form>
    </Page>
  );
}
