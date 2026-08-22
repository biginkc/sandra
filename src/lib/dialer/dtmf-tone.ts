import type { DtmfDigit } from "./transport";

const DTMF_FREQUENCIES: Record<DtmfDigit, readonly [number, number]> = {
  "1": [697, 1209], "2": [697, 1336], "3": [697, 1477],
  "4": [770, 1209], "5": [770, 1336], "6": [770, 1477],
  "7": [852, 1209], "8": [852, 1336], "9": [852, 1477],
  "*": [941, 1209], "0": [941, 1336], "#": [941, 1477],
};

let context: AudioContext | null = null;

/** Plays local feedback only. Provider DTMF is sent separately by CallTransport. */
export function playDtmfTone(digit: DtmfDigit): void {
  if (typeof window === "undefined") return;
  const AudioContextClass = window.AudioContext;
  if (!AudioContextClass) return;
  try {
    context ??= new AudioContextClass();
    const start = context.currentTime;
    const stop = start + 0.09;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.035, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, stop);
    gain.connect(context.destination);
    for (const frequency of DTMF_FREQUENCIES[digit]) {
      const oscillator = context.createOscillator();
      oscillator.frequency.setValueAtTime(frequency, start);
      oscillator.connect(gain);
      oscillator.start(start);
      oscillator.stop(stop);
    }
    if (context.state === "suspended") void context.resume();
  } catch {
    // Audio feedback must never block dialing on browsers that deny WebAudio.
  }
}
