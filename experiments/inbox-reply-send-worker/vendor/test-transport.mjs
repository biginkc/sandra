// Fault-injectable double for RULING 1's real container crash/redelivery
// proof (runtime-proof.py). Bind-mounted read-only into the worker
// container; NEVER used against a real recipient — server.mjs only loads
// this module when INBOX_ACTION_LOCAL_FIXTURE=1 AND
// INBOX_REPLY_SEND_TEST_TRANSPORT_MODULE is set.
//
// Every call appends one line to INBOX_REPLY_SEND_TEST_TRANSPORT_COUNT_FILE
// (a bind-mounted, host-visible, writable file) BEFORE doing anything else,
// so the host-side harness can observe "the provider was called" the
// instant it happens — this is what lets runtime-proof.py catch the worker
// process mid-flight (after the ledger marker committed, before the
// transport call would have returned) and kill it right there. If
// INBOX_REPLY_SEND_TEST_TRANSPORT_SLEEP_MS is set, the call blocks for that
// long before resolving, widening the kill window.
import fs from 'node:fs';
export function createTestReplyTransport() {
  const countFile = process.env.INBOX_REPLY_SEND_TEST_TRANSPORT_COUNT_FILE;
  const sleepMs = Number(process.env.INBOX_REPLY_SEND_TEST_TRANSPORT_SLEEP_MS ?? '0');
  return async (reply, signal) => {
    if (countFile) { try { fs.appendFileSync(countFile, `${Date.now()}\n`); } catch { } }
    if (sleepMs > 0) await new Promise(resolve => setTimeout(resolve, sleepMs));
    signal.throwIfAborted();
    return { kind: 'accepted', externalId: 'owned-runtime-proof-' + Date.now(), providerStatus: 'sent' };
  };
}
