import { describe, expect, it, vi } from "vitest";
import { ALL_ROW_IDS, applyRunOutcomesToMatrix, assertFullAcceptance, resetMatrixForRun } from "../../../e2e/inbox-acceptance/matrix";
import fs from "node:fs";
vi.mock("node:fs", () => ({ default: { readFileSync: vi.fn(), writeFileSync: vi.fn() } }));
const rows = () => ALL_ROW_IDS.map(id => ({ id, status: "pass" as const, evidence: `${id}.png` }));
const matrix = () => ALL_ROW_IDS.map(id => `| ${id} | Requirement | Core | Verify | old pass | old evidence |`).join("\n");
describe("full Inbox acceptance evidence gate", () => {
  it("rejects an Outbox-only green run and every missing required row", () => {
    expect(ALL_ROW_IDS).toHaveLength(50);
    expect(() => assertFullAcceptance(rows().filter(row => row.id.startsWith("O")))).toThrow("F01");
    for (const id of ALL_ROW_IDS) expect(() => assertFullAcceptance(rows().filter(row => row.id !== id))).toThrow(id);
  });
  it("requires real evidence and rejects skips/failures despite another pass", () => {
    expect(() => assertFullAcceptance(rows())).not.toThrow();
    for (const status of ["fail", "skip"] as const) expect(() => assertFullAcceptance([...rows(), { id: "F02", status, evidence: "failed assertion" }])).toThrow("F02");
    expect(() => assertFullAcceptance(rows().map(row => row.id === "R01" ? { ...row, evidence: " " } : row))).toThrow("R01");
  });
  it("removes stale passes for all 50 rows before a run", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(matrix());
    resetMatrixForRun();
    const output = vi.mocked(fs.writeFileSync).mock.lastCall?.[1] as string;
    expect(output).not.toContain("old pass");
    expect(output.match(/No evidence from this run/g)).toHaveLength(50);
  });
  it("records Inbox outcomes and never lets a success hide a skip", () => {
    vi.mocked(fs.readFileSync).mockReturnValue(matrix());
    applyRunOutcomesToMatrix([{ id: "F02", status: "pass", evidence: "search.png" }, { id: "A01", status: "pass", evidence: "accepted.png" }, { id: "A01", status: "skip", evidence: "worker missing" }]);
    const output = vi.mocked(fs.writeFileSync).mock.lastCall?.[1] as string;
    expect(output.split("\n").find(row => row.startsWith("| F02 |"))).toContain("search.png");
    expect(output.split("\n").find(row => row.startsWith("| A01 |"))).toContain("blocked: worker missing");
  });
});
