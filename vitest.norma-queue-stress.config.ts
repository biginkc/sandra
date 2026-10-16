import { defineConfig, mergeConfig } from "vitest/config";

import base from "./vitest.norma-stress.config";

// The Norma stress gate with the queue capacity limits the runtime now requires (dispatch fails closed with
// queue_limits_not_configured without them). Limits are generous: the stress gate tests races, not capacity.
// NORMA_QUEUE_ENABLED stays unset, so only the limits are supplied, never the queue switch.
export default mergeConfig(
  base,
  defineConfig({ test: { env: { NORMA_QUEUE_MAX_CONCURRENT: "1000", NORMA_QUEUE_DAILY_CAP: "100000" } } }),
);
