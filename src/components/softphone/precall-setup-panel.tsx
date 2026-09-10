"use client";
import { useRef, useState } from "react";
import { Accordion } from "@base-ui/react/accordion";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SETUP_FIELDS,
  SETUP_SELECTORS,
  setupOptions,
  setupValues,
  type SetupDraft,
  type SetupField,
  type SetupSelector,
} from "@/lib/coach/precall-setup";
import { resolveFileNumber } from "@/lib/coach/token-resolver";
import type { CoachCallContext } from "@/lib/coach/types";

type Props = {
  collapsed: boolean;
  onCollapsed: (value: boolean) => void;
  targetKey: string;
  context: CoachCallContext | null;
  draft: SetupDraft;
  loading: boolean;
  error: string | null;
  onField: (key: SetupField, value: string) => void;
  onBranch: (key: SetupSelector, value: string) => void;
  onRetry: () => void;
};
const groups = [
  ["basics", "Call basics"],
  ["situation", "Seller’s situation"],
  ["offer", "Offer details"],
  ["branches", "Script branches"],
] as const;
export function PrecallSetupPanel({
  collapsed,
  onCollapsed,
  targetKey,
  context,
  draft,
  loading,
  error,
  onField,
  onBranch,
  onRetry,
}: Props) {
  const values = setupValues(context, draft.edits);
  const triggers = useRef<Record<string, HTMLElement | null>>({});
  const file = context ? resolveFileNumber(context) : null;
  // Unmatched and training numbers intentionally have no lead identity. The
  // file number is unavailable for those calls, but that unavailable value is
  // not a missing field the rep could ever complete.
  const fileExpected = targetKey.startsWith("lead:") || Boolean(context?.leadId);
  const missing = (group: string) =>
    SETUP_FIELDS.filter(
      ([key, , section]) => section === group && !values[key].trim(),
    ).length +
    (group === "basics" && fileExpected && (!file || file.isPlaceholder)
      ? 1
      : 0);
  const needed = missing("basics") + missing("situation");
  const firstIncomplete = missing("basics")
    ? "basics"
    : missing("situation")
      ? "situation"
      : "branches";
  const [selection, setSelection] = useState({
    key: targetKey,
    initialized: !loading,
    open: [loading ? "basics" : firstIncomplete],
  });
  if (selection.key !== targetKey) {
    setSelection({
      key: targetKey,
      initialized: !loading,
      open: [loading ? "basics" : firstIncomplete],
    });
  } else if (!selection.initialized && !loading) {
    setSelection({ ...selection, initialized: true, open: [firstIncomplete] });
  }
  const open = selection.open;
  const setOpen = (open: string[]) =>
    setSelection({ key: targetKey, initialized: true, open });
  const shell =
    "h-[34px] w-full rounded-[10px] border px-2.5 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-700";
  return (
    <section
      data-testid="precall-setup"
      data-target-key={targetKey}
      aria-label="Call setup"
      aria-busy={loading}
      className="my-3 overflow-hidden rounded-[10px] border border-[#e5e1df] bg-white text-[#1c1917]"
    >
      <div className="flex items-center justify-between gap-2 bg-[#f5f5f4] px-3 py-2">
        <span className="text-xs font-extrabold tracking-wide">
          {loading
            ? "Loading call details…"
            : collapsed
              ? needed
                ? `${needed} call details remaining`
                : "Call details ready"
              : "CALL SETUP"}
        </span>
        {!collapsed && !loading && (
          <span role="status" className="text-xs text-[#78350f]">
            {needed ? `${needed} needed` : "Ready"}
          </span>
        )}
        <button
          type="button"
          className="rounded px-1 text-xs font-bold focus-visible:ring-2"
          onClick={() => onCollapsed(!collapsed)}
        >
          {collapsed ? "Edit" : "Collapse"}
        </button>
      </div>
      {collapsed ? (
        <div className="px-3 py-2 text-xs">
        <p>
          {[
            values.seller_name,
            values.property_address,
            setupOptions("Opener").find(option => option.value === draft.branches.Opener)?.label,
            file && !file.isPlaceholder
              ? file.value
              : "File number not available yet",
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
        {!loading && needed > 0 && <p className="mt-1 text-[#78350f]">Still needed: {[...SETUP_FIELDS.filter(([key,,group]) => group !== "offer" && !values[key].trim()).map(([,label])=>label), ...(fileExpected && (!file || file.isPlaceholder) ? ["File number"] : [])].join(", ")}</p>}
        </div>
      ) : (
        <>
          {error && (
            <div role="status" className="px-3 py-2 text-xs text-[#78350f]">
              {error}{" "}
              <button type="button" className="underline" onClick={onRetry}>
                Retry loading details
              </button>
            </div>
          )}
          <Accordion.Root
            onFocusCapture={() => {
              if (!selection.initialized)
                setSelection({ ...selection, initialized: true });
            }}
            multiple={false}
            value={open}
            onValueChange={setOpen}
            className="min-w-0"
          >
            {groups.map(([group, title]) => (
              <Accordion.Item key={group} value={group}>
                <Accordion.Header>
                  <Accordion.Trigger ref={(element) => {
                    triggers.current[group] = element;
                  }} className="flex min-h-10 w-full items-center justify-between border-t border-[#e5e1df] px-3 py-2 text-left text-xs font-bold focus-visible:ring-2">
                    <span>{title}</span>
                    <span className="text-[11px] font-normal">
                      {loading
                        ? "Loading…"
                        : group === "offer"
                          ? "Not known yet is okay"
                          : group === "branches"
                            ? "Choose script paths"
                            : missing(group)
                              ? `${missing(group)} needed`
                              : "Complete"}{" "}
                      ▾
                    </span>
                  </Accordion.Trigger>
                </Accordion.Header>
                <Accordion.Panel
                  className="px-3 pb-3"
                >
                  {group === "branches" ? (
                    <div className="grid grid-cols-2 gap-2">
                      {SETUP_SELECTORS.map(({ key, label }) => (
                        <div key={key}>
                          <label
                            id={`setup-label-${encodeURIComponent(key)}`}
                            className="mb-1 block text-[10px] font-bold"
                          >
                            {label}
                          </label>
                          <Select
                            items={setupOptions(key)}
                            value={draft.branches[key] || null}
                            onValueChange={(value) =>
                              onBranch(key, value ?? "")
                            }
                          >
                            <SelectTrigger
                              aria-labelledby={`setup-label-${encodeURIComponent(key)}`}
                              data-testid={`setup-branch-${key}`}
                              className={`${shell} border-[#e5e1df] bg-[#fafaf9]`}
                            >
                              <SelectValue placeholder="Choose on the call" />
                            </SelectTrigger>
                            <SelectContent
                              positionerClassName="z-[80]"
                              className="z-[80]"
                            >
                              {setupOptions(key).map((option) => (
                                <SelectItem
                                  key={option.value}
                                  value={option.value}
                                >
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {(key === "offer.outcome-tracks" ||
                            key === "close.decision-tracks" ||
                            key === "Motivation") &&
                            draft.branches[key] && (
                              <span className="text-[10px] text-[#57534e]">
                                Tentative — change during the call
                              </span>
                            )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      {SETUP_FIELDS.filter(
                        ([, , section]) => section === group,
                      ).map(([key, label]) => (
                        <label
                          key={key}
                          className={
                            key === "property_address" || group === "situation"
                              ? "col-span-2"
                              : ""
                          }
                        >
                          <span className="mb-1 block text-[10px] font-bold uppercase text-[#57534e]">
                            {label}
                            {!loading &&
                            group !== "offer" &&
                            !values[key].trim()
                              ? " · needed"
                              : ""}
                          </span>
                          {loading && !Object.hasOwn(draft.edits, key) ? (
                            <div
                              aria-label={`${label} loading`}
                              className={`${shell} animate-pulse border-[#e5e1df] bg-[#e5e1df]`}
                            />
                          ) : (
                            <input
                              data-testid={`setup-field-${key}`}
                              value={values[key]}
                              maxLength={group === "situation" ? 2000 : 500}
                              placeholder={
                                group === "offer"
                                  ? "Not known yet"
                                  : `Add ${label.toLowerCase()}`
                              }
                              onChange={(event) =>
                                onField(key, event.target.value)
                              }
                              className={`${shell} ${!values[key].trim() && group !== "offer" ? "border-dashed border-[#b45309] bg-[#fffbeb] placeholder:text-[#78350f]" : "border-[#e5e1df] bg-[#fafaf9] placeholder:text-[#57534e]"}`}
                            />
                          )}
                          {key === "rep_phone" && (
                            <span className="text-[10px] text-[#57534e]">
                              Spoken number; caller ID stays unchanged.
                            </span>
                          )}
                        </label>
                      ))}
                      {group === "basics" && (
                        <div className="col-span-2">
                          <span className="mb-1 block text-[10px] font-bold">
                            FILE NUMBER · AUTO
                          </span>
                          <output
                            data-testid="setup-file-number"
                            aria-label="File number"
                            className="block rounded-[10px] bg-[#f5f5f4] px-2.5 py-2 font-mono text-xs"
                          >
                            {loading
                              ? "Loading…"
                              : file && !file.isPlaceholder
                                ? file.value
                                : "Not available yet"}
                          </output>
                          {!loading && (!file || file.isPlaceholder) && (
                            <p className="mt-1 text-xs text-[#57534e]">
                              Available when rep and lead identity are loaded.
                              You never need to type one.{" "}
                              <button
                                type="button"
                                onClick={onRetry}
                                className="underline"
                              >
                                Retry
                              </button>
                            </p>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {group === "offer" && (
                    <p className="mt-2 text-xs text-[#57534e]">
                      Leave unknown details for the call.
                    </p>
                  )}
                  {!loading && (group === "basics" || group === "situation") && missing(group) === 0 && <button type="button" className="mt-3 rounded px-2 py-1 text-xs font-bold text-[#1c1917] focus-visible:ring-2 focus-visible:ring-blue-700" onClick={() => { const next = group === "basics" ? "situation" : "offer"; setOpen([next]); triggers.current[next]?.focus(); }}>Continue to {group === "basics" ? "seller’s situation" : "offer details"}</button>}
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion.Root>
          <p className="border-t px-3 py-2 text-[11px] text-[#57534e]">
            Selections prepare the script. Nothing is skipped. Press Call to
            begin.
          </p>
        </>
      )}
    </section>
  );
}
