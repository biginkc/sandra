import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDripDetail: vi.fn(), listSequences: vi.fn(), getSequenceAdminStatus: vi.fn(), reportError: vi.fn(),
}));
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("../admin", () => ({ getSequenceAdminStatus: mocks.getSequenceAdminStatus }));
vi.mock("../actions", () => ({ listSequences: mocks.listSequences }));
vi.mock("./detail-data", () => ({ getDripDetail: mocks.getDripDetail }));
vi.mock("./detail-view", () => ({ DripDetailView: () => null }));
vi.mock("@/lib/errors/report", () => ({ reportError: mocks.reportError }));

import DripDetailPage from "./page";

it("logs a detail load failure without rendering the database error", async () => {
  mocks.getDripDetail.mockResolvedValue({ ok: false, error: { code: "DB_ERROR", message: "relation private_table does not exist" } });
  mocks.listSequences.mockResolvedValue({ ok: true, data: [] });
  mocks.getSequenceAdminStatus.mockResolvedValue(false);
  render(await DripDetailPage({ params: Promise.resolve({ id: "sequence-1" }) }));
  expect(screen.getByRole("alert")).toHaveTextContent("We couldn’t load this drip.");
  expect(screen.getByRole("alert")).not.toHaveTextContent("private_table");
  expect(mocks.reportError).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ extra: { sequenceId: "sequence-1", code: "DB_ERROR" } }));
});
