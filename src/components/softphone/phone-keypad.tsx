"use client";

import type { DtmfDigit } from "@/lib/dialer/transport";

export const KEYPAD = [
  ["1", ""], ["2", "ABC"], ["3", "DEF"],
  ["4", "GHI"], ["5", "JKL"], ["6", "MNO"],
  ["7", "PQRS"], ["8", "TUV"], ["9", "WXYZ"],
  ["*", ""], ["0", "+"], ["#", ""],
] as const;

/** Shared by the classic dialer popover and the full-screen coach view so
 * live-call DTMF input looks and behaves identically in both. */
export function PhoneKeypad({ onDigit, disabled = false, disabledDigits = [] }: { onDigit: (digit: DtmfDigit) => void; disabled?: boolean; disabledDigits?: DtmfDigit[] }) {
  return <div data-testid="phone-keypad" className="mt-3 grid grid-cols-3 gap-1.5">{KEYPAD.map(([digit, letters]) => { const key = digit as DtmfDigit; const keyDisabled = disabled || disabledDigits.includes(key); return <button type="button" disabled={keyDisabled} key={digit} aria-label={`Keypad ${digit}`} onClick={() => onDigit(key)} className="flex flex-col items-center rounded-[10px] border border-[#e5e1df] bg-white px-0 py-2 hover:border-[#d6d1ce] hover:bg-[#f5f4f2] disabled:cursor-not-allowed disabled:opacity-35"><span className="text-[17px] font-bold leading-none">{digit}</span><span className="h-2.5 text-[8px] font-bold tracking-[0.12em] text-[#a8a29e]">{letters}</span></button>; })}</div>;
}
