import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { callAction } from "./call-action";
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
describe("callAction record context", () => {
  beforeEach(() => vi.clearAllMocks());
  it("identifies the property on success", async () => {
    await callAction(Promise.resolve({ ok: true, data: null }), { successMessage: "Appointment booked", contextLabel: "123 Main St" });
    expect(toast.success).toHaveBeenCalledWith("Appointment booked", { description: "123 Main St" });
  });
  it("identifies the property on a returned error", async () => {
    await callAction(Promise.resolve({ ok: false, error: { code: "FAILED", message: "Could not book" } }), { contextLabel: "123 Main St" });
    expect(toast.error).toHaveBeenCalledWith("Could not book", { description: "123 Main St — FAILED" });
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("identifies the property when confirmation is lost", async () => {
    await callAction(Promise.reject(new Error("Connection lost")), { contextLabel: "123 Main St", fallbackMessage: "Could not confirm booking" });
    expect(toast.error).toHaveBeenCalledWith("Could not confirm booking", { description: "123 Main St — Connection lost" });
  });
  it("preserves notifications without record context", async () => {
    await callAction(Promise.resolve({ ok: true, data: null }), { successMessage: "Saved" });
    expect(toast.success).toHaveBeenCalledWith("Saved");
  });
});
