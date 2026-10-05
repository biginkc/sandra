"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

import {
  deleteBuyerEntityAction,
  deleteTitleCompanyAction,
  saveBuyerEntityAction,
  saveContractSettingsAction,
  saveTitleCompanyAction,
  type ContractDefaultsActionResult,
} from "./actions";
import { parseTemplateFieldDefaults } from "./validation";

export type TitleCompanyRow = {
  id: string;
  name: string;
  closingAgentName: string;
  closingAgentPhone: string;
  closingAgentAddress: string;
  closingAgentEmail: string;
  isActive: boolean;
};
export type BuyerEntityRow = {
  id: string;
  name: string;
  phone: string;
  email: string;
  attorneyInFact: string;
  isActive: boolean;
};
export type ContractDefaultsInitial = {
  titleCompanies: TitleCompanyRow[];
  buyerEntities: BuyerEntityRow[];
  settings: {
    followUpDays: number;
    followUpHour: number;
    templateFieldDefaultsText: string;
  };
};

function useRun() {
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ContractDefaultsActionResult>, okText = "Saved.", onOk?: () => void) =>
    start(async () => {
      const r = await fn();
      setMessage(r.ok ? { ok: true, text: okText } : { ok: false, text: r.message });
      if (r.ok) onOk?.();
    });
  const note = message && (
    <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-sm" : "text-destructive text-sm"}>
      {message.text}
    </p>
  );
  return { run, pending, note };
}

function Field({
  id,
  label,
  value,
  onChange,
  required,
  type,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  type?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>
        {label}
        {required ? " *" : ""}
      </Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

function ActiveToggle({ id, checked, onChange }: { id: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm">
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      Active
    </label>
  );
}

function TitleCompanyEditor({ row }: { row: TitleCompanyRow | null }) {
  const [v, setV] = useState<TitleCompanyRow>(
    row ?? { id: "", name: "", closingAgentName: "", closingAgentPhone: "", closingAgentAddress: "", closingAgentEmail: "", isActive: true },
  );
  const { run, pending, note } = useRun();
  const k = `tc-${row?.id ?? "new"}`;
  const set = (p: Partial<TitleCompanyRow>) => setV((c) => ({ ...c, ...p }));
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid={k}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field id={`${k}-name`} label="Title company name" required value={v.name} onChange={(x) => set({ name: x })} />
        <Field id={`${k}-agent`} label="Closing agent name" required value={v.closingAgentName} onChange={(x) => set({ closingAgentName: x })} />
        <Field id={`${k}-phone`} label="Closing agent phone" value={v.closingAgentPhone} onChange={(x) => set({ closingAgentPhone: x })} />
        <Field id={`${k}-email`} label="Closing agent email" value={v.closingAgentEmail} onChange={(x) => set({ closingAgentEmail: x })} />
        <Field id={`${k}-address`} label="Closing agent address" value={v.closingAgentAddress} onChange={(x) => set({ closingAgentAddress: x })} />
        <div className="flex items-end">
          <ActiveToggle id={`${k}-active`} checked={v.isActive} onChange={(x) => set({ isActive: x })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => saveTitleCompanyAction({ id: row?.id, name: v.name, closingAgentName: v.closingAgentName, closingAgentPhone: v.closingAgentPhone, closingAgentAddress: v.closingAgentAddress, closingAgentEmail: v.closingAgentEmail, isActive: v.isActive }),
              "Saved.",
              () => {
                if (!row) setV({ id: "", name: "", closingAgentName: "", closingAgentPhone: "", closingAgentAddress: "", closingAgentEmail: "", isActive: true });
              },
            )
          }
        >
          {row ? "Save title company" : "Add title company"}
        </Button>
        {row && (
          <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(() => deleteTitleCompanyAction(row.id), "Deleted.")}>
            Delete
          </Button>
        )}
        {note}
      </div>
    </div>
  );
}

function BuyerEntityEditor({ row }: { row: BuyerEntityRow | null }) {
  const [v, setV] = useState<BuyerEntityRow>(
    row ?? { id: "", name: "", phone: "", email: "", attorneyInFact: "", isActive: true },
  );
  const { run, pending, note } = useRun();
  const k = `be-${row?.id ?? "new"}`;
  const set = (p: Partial<BuyerEntityRow>) => setV((c) => ({ ...c, ...p }));
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3" data-testid={k}>
      <div className="grid gap-3 md:grid-cols-2">
        <Field id={`${k}-name`} label="Buyer entity name" required value={v.name} onChange={(x) => set({ name: x })} />
        <Field id={`${k}-aif`} label="Attorney in fact" value={v.attorneyInFact} onChange={(x) => set({ attorneyInFact: x })} />
        <Field id={`${k}-phone`} label="Phone" value={v.phone} onChange={(x) => set({ phone: x })} />
        <Field id={`${k}-email`} label="Email" value={v.email} onChange={(x) => set({ email: x })} />
        <div className="flex items-end">
          <ActiveToggle id={`${k}-active`} checked={v.isActive} onChange={(x) => set({ isActive: x })} />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(
              () => saveBuyerEntityAction({ id: row?.id, name: v.name, phone: v.phone, email: v.email, attorneyInFact: v.attorneyInFact, isActive: v.isActive }),
              "Saved.",
              () => {
                if (!row) setV({ id: "", name: "", phone: "", email: "", attorneyInFact: "", isActive: true });
              },
            )
          }
        >
          {row ? "Save buyer entity" : "Add buyer entity"}
        </Button>
        {row && (
          <Button size="sm" variant="destructive" disabled={pending} onClick={() => run(() => deleteBuyerEntityAction(row.id), "Deleted.")}>
            Delete
          </Button>
        )}
        {note}
      </div>
    </div>
  );
}

function SettingsEditor({ initial }: { initial: ContractDefaultsInitial["settings"] }) {
  const [days, setDays] = useState(String(initial.followUpDays));
  const [hour, setHour] = useState(String(initial.followUpHour));
  const [text, setText] = useState(initial.templateFieldDefaultsText);
  const { run, pending, note } = useRun();
  const parsed = parseTemplateFieldDefaults(text);
  const blocked = !parsed.ok;
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 md:grid-cols-3">
        <Field id="st-days" label="Follow-up days before closing" type="number" value={days} onChange={setDays} />
        <Field id="st-hour" label="Follow-up hour (Central, 0-23)" type="number" value={hour} onChange={setHour} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="st-fields">Template field defaults (one key=value per line)</Label>
        <Textarea id="st-fields" rows={6} value={text} onChange={(e) => setText(e.target.value)} />
        {!parsed.ok && (
          <ul role="alert" className="text-destructive text-sm">
            {parsed.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={pending || blocked}
          onClick={() =>
            run(() =>
              saveContractSettingsAction({
                followUpDays: Number(days),
                followUpHour: Number(hour),
                templateFieldDefaultsText: text,
              }),
            )
          }
        >
          Save settings
        </Button>
        {note}
      </div>
    </div>
  );
}

export function ContractDefaultsForm({ initial }: { initial: ContractDefaultsInitial }) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader><CardTitle>Title companies</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {initial.titleCompanies.map((t) => (
            <TitleCompanyEditor key={t.id} row={t} />
          ))}
          <TitleCompanyEditor row={null} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Buyer entities</CardTitle></CardHeader>
        <CardContent className="flex flex-col gap-3">
          {initial.buyerEntities.map((b) => (
            <BuyerEntityEditor key={b.id} row={b} />
          ))}
          <BuyerEntityEditor row={null} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Settings</CardTitle></CardHeader>
        <CardContent>
          <SettingsEditor initial={initial.settings} />
        </CardContent>
      </Card>
    </div>
  );
}
