import test from "node:test";
import assert from "node:assert/strict";

import { planSourceMessages, projectionGenerationReady, projectionObservationReady, readSourceScenario } from "./source-arrival-adapter.mjs";

const id = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const scenario = {
  orgId: id(1),
  conversationId: id(2),
  contactId: id(3),
  propertyId: id(4),
  fromAddress: "+18165550101",
  toAddress: "+18165550102",
};

test("requires explicit pre-seeded source identities", () => {
  assert.deepEqual(readSourceScenario(scenario), scenario);
  assert.throws(() => readSourceScenario({ ...scenario, propertyId: undefined }), /propertyId/);
  assert.throws(() => readSourceScenario({ ...scenario, fromAddress: "" }), /fromAddress/);
});

test("plans durable open-loop ids and burst cadence before insertion", () => {
  const planned = planSourceMessages({
    count: 5,
    startAtMs: 1_000,
    arrivalRateRps: 2,
    burstSize: 2,
    burstGapMs: 5,
    idFactory: (() => {
      let index = 10;
      return () => id(index++);
    })(),
  });
  assert.deepEqual(planned.map((message) => message.id), [id(10), id(11), id(12), id(13), id(14)]);
  assert.deepEqual(planned.map((message) => message.plannedAtMs), [1_000, 1_005, 1_500, 1_505, 2_000]);
  assert.ok(planned.every((message) => message.status === "planned"));
  assert.throws(() => planSourceMessages({ count: 2, startAtMs: 1_000, arrivalRateRps: 1, idFactory: () => "not-a-uuid" }), /source message 0 id/);
  assert.throws(() => planSourceMessages({ count: 2, startAtMs: 1_000, arrivalRateRps: 1, idFactory: () => id(10) }), /duplicated/);
  assert.throws(() => planSourceMessages({ count: 6, maxMessages: 5, startAtMs: 1_000, arrivalRateRps: 1 }), /source message count must be a safe integer from 1 through 5/);
});

test("counts an exact new source message only after all projection generations agree", () => {
  const messageId = id(10);
  const pending = {
    org_id: scenario.orgId,
    target_kind: "known_conversation",
    target_id: scenario.conversationId,
    revision: 8,
    source_generation: 8,
    exists: true,
    last_message_id: id(9),
    dirty_generation: 9,
    bridge_source_generation: 8,
    bridge_revision: 8,
    filter_revision: 8,
  };
  assert.equal(projectionObservationReady(pending, messageId, scenario), false);
  const ready = {
    ...pending,
    revision: 9,
    source_generation: 9,
    last_message_id: messageId,
    bridge_source_generation: 9,
    bridge_revision: 9,
    filter_revision: 9,
  };
  assert.equal(projectionObservationReady(ready, messageId, scenario), true);
});

test("a preexisting projected row cannot qualify for a new source message", () => {
  const row = {
    org_id: scenario.orgId,
    target_kind: "known_conversation",
    target_id: scenario.conversationId,
    revision: 4,
    source_generation: 4,
    exists: true,
    last_message_id: id(20),
    dirty_generation: 4,
    bridge_source_generation: 4,
    bridge_revision: 4,
    filter_revision: 4,
  };
  assert.equal(projectionObservationReady(row, id(21), scenario), false);
});

test("accepts a coherent coalesced generation after an intermediate message was superseded", () => {
  const row = {
    org_id: scenario.orgId,
    target_kind: "known_conversation",
    target_id: scenario.conversationId,
    revision: 12,
    source_generation: 12,
    exists: true,
    // A later summary id is valid once the target generation has caught up
    // through the source message's server-owned inbound revision.
    last_message_id: id(30),
    dirty_generation: 12,
    bridge_source_generation: 12,
    bridge_revision: 12,
    filter_revision: 12,
  };
  // The inbound revision may be any independent counter; readiness uses the
  // post-commit dirty generation captured for this source write.
  assert.equal(projectionGenerationReady(row, 11, scenario), true);
  assert.equal(projectionGenerationReady(row, 13, scenario), false);
  assert.equal(projectionGenerationReady({ ...row, source_generation: 10, dirty_generation: 10, bridge_source_generation: 10 }, 11, scenario), false);
});

test("accepts the captured generation while a later source write has advanced dirty", () => {
  const row = {
    org_id: scenario.orgId,
    target_kind: "known_conversation",
    target_id: scenario.conversationId,
    revision: 3,
    source_generation: 8,
    exists: true,
    dirty_generation: 9,
    bridge_source_generation: 8,
    bridge_revision: 3,
    filter_revision: 3,
  };

  assert.equal(projectionGenerationReady(row, 8, scenario), true);
  assert.equal(
    projectionGenerationReady({ ...row, dirty_generation: 7 }, 8, scenario),
    false,
  );
});
