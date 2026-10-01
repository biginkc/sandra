import { describe, expect, it } from 'vitest';

import { createPcmDiagnosticBinding, type BoundPcmDiagnostic } from './speech-diagnostic-binding';

const summary = { track: 'tab', epoch: 1, worklet: null, framesAccepted: 0, framesDelivered: 0, contextStateChanges: 0, finalContextState: 'closed', tailReceived: false } as const;

describe('PCM diagnostic identity binding', () => {
  it('keeps delayed capture A disposal under A when capture B replaces it', async () => {
    const receipts: BoundPcmDiagnostic[] = [];
    const captureA = createPcmDiagnosticBinding((receipt) => receipts.push(receipt));
    const captureB = createPcmDiagnosticBinding((receipt) => receipts.push(receipt));
    captureA.onDiagnostic(summary); // Pre-authorization remains unknown.
    captureA.bindCaptureId('capture-a');
    let releaseA!: () => void;
    const deferredA = new Promise<void>((resolve) => { releaseA = resolve; }).then(() => captureA.onDiagnostic(summary));
    captureB.bindCaptureId('capture-b');
    captureB.onDiagnostic(summary);
    releaseA();
    await deferredA;
    expect(receipts.map((receipt) => receipt.captureId)).toEqual([null, 'capture-b', 'capture-a']);
    expect(() => captureA.bindCaptureId('capture-b')).toThrow('already bound');
  });
});
