"use client";

import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import type { TemplateSignerRole } from "./types";

export function SignerRoleEditor({
  roles,
  sellerRoleName,
  onChange,
}: {
  roles: readonly TemplateSignerRole[];
  sellerRoleName: string;
  onChange: (roles: readonly TemplateSignerRole[], sellerRoleName: string) => void;
}) {
  const updateName = (index: number, name: string) => {
    const previousName = roles[index]?.name;
    const next = roles.map((role, roleIndex) =>
      roleIndex === index ? { ...role, name } : role,
    );
    onChange(next, previousName === sellerRoleName ? name : sellerRoleName);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= roles.length) return;
    const next = [...roles];
    const [role] = next.splice(from, 1);
    next.splice(to, 0, role);
    onChange(
      next.map((entry, order) => ({ ...entry, order })),
      sellerRoleName,
    );
  };

  const remove = (index: number) => {
    if (roles.length === 1) return;
    const removed = roles[index];
    const next = roles
      .filter((_, roleIndex) => roleIndex !== index)
      .map((entry, order) => ({ ...entry, order }));
    onChange(
      next,
      removed.name === sellerRoleName ? (next[0]?.name ?? "") : sellerRoleName,
    );
  };

  const add = () => {
    const name = `Signer ${roles.length + 1}`;
    const next = [...roles, { name, order: roles.length }];
    onChange(next, sellerRoleName || name);
  };

  return (
    <fieldset className="space-y-3">
      <div>
        <legend className="text-sm font-medium">Required signer roles</legend>
        <p className="text-muted-foreground text-xs">
          Every role listed here must be assigned when the template is sent.
        </p>
      </div>
      <div className="space-y-2">
        {roles.map((role, index) => (
          <div key={role.order} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 rounded-lg border p-2">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="radio"
                name="seller-role"
                checked={sellerRoleName === role.name}
                onChange={() => onChange(roles, role.name)}
                aria-label={`${role.name || `Role ${index + 1}`} is the seller role`}
              />
              Seller
            </label>
            <div>
              <Label htmlFor={`signer-role-${index}`} className="sr-only">
                Signer role {index + 1}
              </Label>
              <Input
                id={`signer-role-${index}`}
                value={role.name}
                onChange={(event) => updateName(index, event.target.value)}
                aria-label={`Signer role ${index + 1}`}
              />
            </div>
            <div className="flex gap-1">
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => move(index, index - 1)} disabled={index === 0} aria-label={`Move ${role.name} up`}>
                <ArrowUpIcon />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => move(index, index + 1)} disabled={index === roles.length - 1} aria-label={`Move ${role.name} down`}>
                <ArrowDownIcon />
              </Button>
              <Button type="button" variant="ghost" size="icon-sm" onClick={() => remove(index)} disabled={roles.length === 1} aria-label={`Remove ${role.name}`}>
                <Trash2Icon />
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button type="button" variant="outline" size="sm" onClick={add}>
        <PlusIcon data-icon="inline-start" /> Add role
      </Button>
    </fieldset>
  );
}
