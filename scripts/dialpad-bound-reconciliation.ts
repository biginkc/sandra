export {};
/** Disabled by default. Run explicitly with NODE_OPTIONS=--conditions=react-server and tsx.
 * No scheduler installed. Uses configured server credentials; never prints snapshots. */
async function main() {
 if(process.env.DIALPAD_BOUND_RECONCILIATION_ENABLED!=='true') throw new Error('Bound reconciliation is disabled');
 const [{createDialpadVoiceAdminClient},{DialpadVoiceClient},{reconciliationStore},{reconcileBoundDialpadCalls}]=await Promise.all([
 import('../src/lib/dialpad-voice/database'),import('../src/lib/dialpad-voice/client'),import('../src/lib/dialpad-voice/reconciliation-store'),import('../src/lib/dialpad-voice/reconciliation')]);
 const client=createDialpadVoiceAdminClient<import('../src/lib/dialpad-voice/reconciliation-store').ReconciliationDatabase>();
 const api=new DialpadVoiceClient(process.env.DIALPAD_VOICE_API_KEY??'');
 console.log(await reconcileBoundDialpadCalls(reconciliationStore(client,'00000000-0000-0000-0000-000000000bbb'),api));
}
main().catch(()=>{console.error('Bound reconciliation did not complete');process.exitCode=1;});
