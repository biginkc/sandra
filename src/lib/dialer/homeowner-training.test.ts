import { afterEach, describe, expect, it, vi } from "vitest";
import { canCallHomeownerTraining, isHomeownerTrainingNumber } from "./homeowner-training";
const operator = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
afterEach(() => vi.unstubAllEnvs());
describe("homeowner training reservation", () => {
  it("requires exact destination, explicit enablement and a valid whole operator allowlist", () => {
    vi.stubEnv("HOMEOWNER_TRAINING_NUMBER", "+18165550199");
    vi.stubEnv("HOMEOWNER_TRAINING_ENABLED", "true");
    vi.stubEnv("HOMEOWNER_TRAINING_OPERATOR_IDS", operator);
    expect(canCallHomeownerTraining("+18165550199", operator)).toBe(true);
    expect(canCallHomeownerTraining("+18165550198", operator)).toBe(false);
    expect(canCallHomeownerTraining("+18165550199", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe(false);
    vi.stubEnv("HOMEOWNER_TRAINING_OPERATOR_IDS", `${operator},invalid`);
    expect(canCallHomeownerTraining("+18165550199", operator)).toBe(false);
  });
  it("permits any authenticated operator in public mode while preserving reservation and disablement", () => {
    vi.stubEnv("HOMEOWNER_TRAINING_NUMBER", "+18165550199");
    vi.stubEnv("HOMEOWNER_TRAINING_ENABLED", "true");
    vi.stubEnv("HOMEOWNER_TRAINING_PUBLIC_ACCESS", "true");
    vi.stubEnv("HOMEOWNER_TRAINING_OPERATOR_IDS", "");
    expect(canCallHomeownerTraining("+18165550199", operator)).toBe(true);
    expect(canCallHomeownerTraining("+18165550199", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe(true);
    expect(canCallHomeownerTraining("+18165550199", "")).toBe(false);
    expect(canCallHomeownerTraining("+18165550198", operator)).toBe(false);
    vi.stubEnv("HOMEOWNER_TRAINING_ENABLED", "false");
    expect(canCallHomeownerTraining("+18165550199", operator)).toBe(false);
  });
  it("keeps a disabled number reserved, without permitting a call", () => {
    vi.stubEnv("HOMEOWNER_TRAINING_NUMBER", "+18165550199");
    vi.stubEnv("HOMEOWNER_TRAINING_ENABLED", "false");
    expect(isHomeownerTrainingNumber("+18165550199")).toBe(true);
    expect(canCallHomeownerTraining("+18165550199", operator)).toBe(false);
    vi.stubEnv("HOMEOWNER_TRAINING_NUMBER", "invalid");
    expect(isHomeownerTrainingNumber("invalid")).toBe(false);
  });
});
