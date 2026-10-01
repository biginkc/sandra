import type { PcmWorkletDiagnostic } from './pcm-audio-worklet';

export type BoundPcmDiagnostic = PcmWorkletDiagnostic & { readonly captureId: string | null };

/** One preparation owns its diagnostic identity, including delayed disposal. */
export function createPcmDiagnosticBinding(emit: (summary: BoundPcmDiagnostic) => void) {
  let captureId: string | null = null;
  let bound = false;
  return {
    bindCaptureId(id: string): void {
      if (bound) throw new Error('PCM diagnostic capture identity was already bound.');
      captureId = id;
      bound = true;
    },
    onDiagnostic(summary: PcmWorkletDiagnostic): void {
      emit({ ...summary, captureId });
    },
  };
}
