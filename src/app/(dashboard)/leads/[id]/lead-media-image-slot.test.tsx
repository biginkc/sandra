import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveLeadMediaPresentation: vi.fn(),
}));

vi.mock("./lead-media", () => ({
  resolveLeadMediaPresentation: mocks.resolveLeadMediaPresentation,
}));

vi.mock("./lead-media-image", () => ({
  LeadMediaImage: () => null,
}));

import { LeadMediaImageSlot } from "./lead-media-image-slot";

describe("LeadMediaImageSlot", () => {
  beforeEach(() => {
    mocks.resolveLeadMediaPresentation.mockReset();
  });

  it("resolves only the location supplied by the parent and passes it to the client image", async () => {
    const location = {
      lat: 39.0997,
      lon: -94.5786,
      address: "123 Main St",
      city: "Kansas City",
      state: "MO",
      zip: "64111",
    };
    const media = { kind: "flat" as const, reason: "missing-location" as const };
    mocks.resolveLeadMediaPresentation.mockResolvedValue(media);

    const result = await LeadMediaImageSlot({
      location,
      address: "123 Main St",
    });

    expect(mocks.resolveLeadMediaPresentation).toHaveBeenCalledWith(location);
    expect(result).toMatchObject({
      props: {
        media,
        address: "123 Main St",
        showPreviewMisconfiguration: process.env.VERCEL_ENV === "preview",
      },
    });
  });

  it("contains resolver failures as a typed flat presentation", async () => {
    const resolverError = new Error("metadata unavailable");
    mocks.resolveLeadMediaPresentation.mockRejectedValue(resolverError);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      const result = await LeadMediaImageSlot({
        location: {
          lat: 39.0997,
          lon: -94.5786,
          address: "123 Main St",
          city: "Kansas City",
          state: "MO",
          zip: "64111",
        },
        address: "123 Main St",
      });

      expect(result).toMatchObject({
        props: {
          media: { kind: "flat", reason: "resolver-error" },
          address: "123 Main St",
        },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        "[lead-media] presentation resolver failed",
        { message: "metadata unavailable" },
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
