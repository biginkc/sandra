import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  bulkQueueSms,
  listSmsTemplateCategories,
  countAlreadyContacted,
  assessBulkSmsAudience,
  listDeliveryOptions,
  refreshDeliveryCatalog,
  routerPush,
} = vi.hoisted(() => ({
  bulkQueueSms: vi.fn(),
  listSmsTemplateCategories: vi.fn(),
  countAlreadyContacted: vi.fn(),
  assessBulkSmsAudience: vi.fn(),
  listDeliveryOptions: vi.fn(),
  refreshDeliveryCatalog: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock("./actions", () => ({
  bulkQueueSms,
  listSmsTemplateCategories,
  countAlreadyContacted,
  assessBulkSmsAudience,
}));

vi.mock("../campaigns/actions", () => ({
  listDeliveryOptions,
  refreshDeliveryCatalog,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush }),
}));

import { BulkSmsModal, computeDrain } from "./bulk-sms-modal";

function renderModal(
  propertyIds: string[],
  overrides: Partial<{
    open: boolean;
    onClose: () => void;
    onQueued: (n: number) => void;
  }> = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const onQueued = overrides.onQueued ?? vi.fn();
  return render(
    <BulkSmsModal
      open={overrides.open ?? true}
      propertyIds={propertyIds}
      onClose={onClose}
      onQueued={onQueued}
    />,
  );
}

async function fillCampaignName(
  user: ReturnType<typeof userEvent.setup>,
  name = "June Vacant Homes",
) {
  await user.type(
    screen.getByRole("textbox", { name: /Campaign name/i }),
    name,
  );
}

const deliveryCatalog = {
  provider: "test-provider",
  senders: [
    {
      phoneE164: "+15551234567",
      provider: "test-provider",
      status: "active",
      messagingStatus: "approved",
      lastSyncedAt: "2026-06-30T12:00:00.000Z",
    },
  ],
  providerCampaigns: [
    {
      externalId: "pc-1",
      provider: "test-provider",
      name: "BMH Outreach",
      brand: null,
      useCase: null,
      status: "active",
      lastSyncedAt: "2026-06-30T12:00:00.000Z",
    },
  ],
  lastSyncedAt: "2026-06-30T12:00:00.000Z",
};

async function selectSender(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("option", {
    name: /Test Provider — \+15551234567/i,
  });
  await user.selectOptions(
    screen.getByLabelText(/sending number/i),
    "+15551234567",
  );
}

beforeEach(() => {
  bulkQueueSms.mockReset();
  listSmsTemplateCategories.mockReset();
  countAlreadyContacted.mockReset();
  routerPush.mockReset();

  listSmsTemplateCategories.mockResolvedValue({
    ok: true,
    data: [
      { category: "Opener - Homeowner", count: 15 },
      { category: "Outreach - Homeowner", count: 9 },
    ],
  });
  countAlreadyContacted.mockResolvedValue({ ok: true, data: 0 });
  listDeliveryOptions.mockReset();
  refreshDeliveryCatalog.mockReset();
  listDeliveryOptions.mockResolvedValue({ ok: true, data: deliveryCatalog });
  refreshDeliveryCatalog.mockResolvedValue({
    ok: true,
    data: {
      supported: true,
      provider: "test-provider",
      senderCount: 1,
      providerCampaignCount: 1,
    },
  });
  // All-mobile by default so the textable count matches the selection
  // size and pre-existing label/drain assertions hold unchanged.
  assessBulkSmsAudience.mockReset();
  assessBulkSmsAudience.mockImplementation((ids: string[]) =>
    Promise.resolve({
      ok: true,
      data: {
        total: ids.length,
        mobile: ids.length,
        landline: 0,
        unknown: 0,
        noPhone: 0,
      },
    }),
  );
  bulkQueueSms.mockResolvedValue({
    ok: true,
    data: { succeeded: 0, skipped: 0, failed: [] },
  });
});

describe("<BulkSmsModal /> pacing + skip-contacted (260504-tgq)", () => {
  it("renders campaign name blank by default", async () => {
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    expect(screen.getByRole("textbox", { name: /Campaign name/i })).toHaveValue(
      "",
    );
  });

  it("requires a non-whitespace campaign name before queueing", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));
    expect(screen.getByText("Campaign name is required.")).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /Campaign name/i }),
    ).toHaveFocus();
    expect(bulkQueueSms).not.toHaveBeenCalled();

    await user.type(
      screen.getByRole("textbox", { name: /Campaign name/i }),
      "   ",
    );
    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));
    expect(bulkQueueSms).not.toHaveBeenCalled();
  });

  // 260506-m3a: presets replace the always-visible pace inputs. Custom
  // mode preserves the raw inputs, so each test that touches them now
  // selects Custom first.

  it("Custom mode pacing input defaults to 18 with seconds unit", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);

    // Wait for the open-time effects to settle (categories + count fetch).
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    await user.click(screen.getByRole("radio", { name: /Custom/i }));

    const paceInput = screen.getByLabelText(/^Pacing$/i) as HTMLInputElement;
    expect(paceInput.value).toBe("18");

    const paceUnit = screen.getByLabelText(/Pacing unit/i) as HTMLSelectElement;
    expect(paceUnit.value).toBe("seconds");
  });

  it("Selecting 'minutes' and entering 5 submits paceSeconds=300", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });

    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    await user.click(screen.getByRole("radio", { name: /Custom/i }));

    const paceInput = screen.getByLabelText(/^Pacing$/i);
    const paceUnit = screen.getByLabelText(/Pacing unit/i);

    await user.clear(paceInput);
    await user.type(paceInput, "5");
    await user.selectOptions(paceUnit, "minutes");
    await fillCampaignName(user);
    await selectSender(user);

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));

    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [ids, opts] = bulkQueueSms.mock.calls[0];
    expect(ids).toEqual(["p1"]);
    expect(opts.campaignName).toBe("June Vacant Homes");
    expect(opts.paceSeconds).toBe(300);
  });

  it("Pacing of 5 seconds shows inline validation error and submit does not call bulkQueueSms", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    await user.click(screen.getByRole("radio", { name: /Custom/i }));
    await fillCampaignName(user);

    const paceInput = screen.getByLabelText(/^Pacing$/i);
    await user.clear(paceInput);
    await user.type(paceInput, "5");

    // Inline error renders below the field.
    expect(
      await screen.findByText(/between 10 seconds and 10 minutes/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));

    expect(bulkQueueSms).not.toHaveBeenCalled();
  });

  it("Pacing of 11 minutes shows inline validation error and submit does not call bulkQueueSms", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    await user.click(screen.getByRole("radio", { name: /Custom/i }));
    await fillCampaignName(user);

    const paceInput = screen.getByLabelText(/^Pacing$/i);
    const paceUnit = screen.getByLabelText(/Pacing unit/i);

    await user.clear(paceInput);
    await user.type(paceInput, "11");
    await user.selectOptions(paceUnit, "minutes");

    expect(
      await screen.findByText(/between 10 seconds and 10 minutes/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));

    expect(bulkQueueSms).not.toHaveBeenCalled();
  });

  it("Skip-contacted checkbox is checked by default when propertyIds.length is 51", async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `p${i + 1}`);
    renderModal(ids);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    const skipCheckbox = screen.getByRole("checkbox", {
      name: /Skip prospects already contacted/i,
    }) as HTMLInputElement;
    expect(skipCheckbox.checked).toBe(true);
  });

  it("Skip-contacted checkbox is unchecked by default when propertyIds.length is 50", async () => {
    const ids = Array.from({ length: 50 }, (_, i) => `p${i + 1}`);
    renderModal(ids);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    const skipCheckbox = screen.getByRole("checkbox", {
      name: /Skip prospects already contacted/i,
    }) as HTMLInputElement;
    expect(skipCheckbox.checked).toBe(false);
  });

  it("Modal open fires countAlreadyContacted with the given propertyIds and renders the returned count in the checkbox label", async () => {
    countAlreadyContacted.mockResolvedValue({ ok: true, data: 24 });

    renderModal(["p1", "p2", "p3"]);

    await waitFor(() =>
      expect(countAlreadyContacted).toHaveBeenCalledWith(["p1", "p2", "p3"]),
    );

    // Once loaded the label should include the live count.
    expect(
      await screen.findByText(/Skip prospects already contacted \(24\)/i),
    ).toBeInTheDocument();
  });

  it("Submit passes paceSeconds AND skipIfContacted to bulkQueueSms", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    countAlreadyContacted.mockResolvedValue({ ok: true, data: 7 });

    // 51 ids → skip-contacted defaults to true.
    const ids = Array.from({ length: 51 }, (_, i) => `p${i + 1}`);
    renderModal(ids);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    await waitFor(() => expect(countAlreadyContacted).toHaveBeenCalled());

    await user.click(screen.getByRole("radio", { name: /Custom/i }));
    await fillCampaignName(user, "  Skip Contacted Campaign  ");
    await selectSender(user);

    const paceInput = screen.getByLabelText(/^Pacing$/i);
    await user.clear(paceInput);
    await user.type(paceInput, "30");

    await user.click(
      screen.getByRole("button", { name: /Queue 51 messages/i }),
    );

    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [, opts] = bulkQueueSms.mock.calls[0];
    expect(opts.paceSeconds).toBe(30);
    expect(opts.skipIfContacted).toBe(true);
    expect(opts.campaignName).toBe("Skip Contacted Campaign");
    // Template-pool mode should also forward the category.
    expect(opts.templateCategory).toBe("Opener - Homeowner");
  });

  // Removed in 260506-m3a — drain estimate replaces the per-second helper text.
});

describe("<BulkSmsModal /> presets + drain estimate (260506-m3a)", () => {
  it("renders 4 preset radios with Steady checked by default", async () => {
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    const steady = screen.getByRole("radio", {
      name: /Steady/i,
    }) as HTMLInputElement;
    const conservative = screen.getByRole("radio", {
      name: /Conservative/i,
    }) as HTMLInputElement;
    const push = screen.getByRole("radio", {
      name: /Push/i,
    }) as HTMLInputElement;
    const custom = screen.getByRole("radio", {
      name: /Custom/i,
    }) as HTMLInputElement;
    expect(steady.checked).toBe(true);
    expect(conservative.checked).toBe(false);
    expect(push.checked).toBe(false);
    expect(custom.checked).toBe(false);
  });

  it("Push preset shows the 'fast continuous drain' tagline", async () => {
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    expect(screen.getByText(/fast continuous drain/i)).toBeInTheDocument();
  });

  it("switching from Steady → Conservative updates the drain estimate", async () => {
    const user = userEvent.setup();
    // No caps — the full 500 stay in one continuous ramp on every
    // preset; only the pace (and therefore the last-send time) changes.
    const ids = Array.from({ length: 500 }, (_, i) => `p${i + 1}`);
    renderModal(ids);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    const drainBefore = screen.getByTestId("drain-estimate").textContent ?? "";
    expect(drainBefore).toMatch(/500/);

    await user.click(screen.getByRole("radio", { name: /Conservative/i }));
    const drainAfter = screen.getByTestId("drain-estimate").textContent ?? "";
    // Still all 500 queued (no per-day split), but the slower pace
    // moves the last-send estimate.
    expect(drainAfter).toMatch(/500/);
    expect(drainAfter).not.toBe(drainBefore);
  });

  it("Custom mode reveals raw pace inputs and never offers a daily cap; other presets hide them", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    // Steady default — raw pace input is hidden. Anchored regex so we
    // don't pick up tagline text wrapping the Custom radio's <label>.
    expect(screen.queryByLabelText(/^Pacing$/i)).toBeNull();

    await user.click(screen.getByRole("radio", { name: /Custom/i }));

    expect(screen.getByLabelText(/^Pacing$/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Pacing unit/i)).toBeInTheDocument();
    // No client-side caps — credits at the provider are the only cap.
    expect(screen.queryByLabelText(/^Daily cap$/i)).toBeNull();
  });

  it("Submit forwards paceSeconds + jitterPct=0.20 from the active preset, with NO dailyCap", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    await fillCampaignName(user);
    await selectSender(user);

    // Default = Steady → 8s pace, 0.20 jitter, no cap
    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));
    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [, opts] = bulkQueueSms.mock.calls[0];
    expect(opts.campaignName).toBe("June Vacant Homes");
    expect(opts.paceSeconds).toBe(8);
    expect(opts.jitterPct).toBeCloseTo(0.2, 5);
    expect("dailyCap" in opts).toBe(false);
  });

  it("Push preset submits paceSeconds=4 with no dailyCap", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    await fillCampaignName(user);
    await selectSender(user);

    await user.click(screen.getByRole("radio", { name: /Push/i }));
    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));

    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [, opts] = bulkQueueSms.mock.calls[0];
    expect(opts.campaignName).toBe("June Vacant Homes");
    expect(opts.paceSeconds).toBe(4);
    expect("dailyCap" in opts).toBe(false);
  });

  it("Custom mode forwards the raw pace with no dailyCap", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    await fillCampaignName(user);
    await selectSender(user);

    await user.click(screen.getByRole("radio", { name: /Custom/i }));
    const paceInput = screen.getByLabelText(/^Pacing$/i);
    await user.clear(paceInput);
    await user.type(paceInput, "30");

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));
    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [, opts] = bulkQueueSms.mock.calls[0];
    expect(opts.campaignName).toBe("June Vacant Homes");
    expect(opts.paceSeconds).toBe(30);
    expect("dailyCap" in opts).toBe(false);
  });

  it("Custom message submit forwards trimmed campaignName and body", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    await fillCampaignName(user, "  Custom Campaign  ");
    await selectSender(user);
    await user.click(screen.getByRole("button", { name: /Custom message/i }));
    await user.type(
      screen.getByPlaceholderText(/interested in your property/i),
      "  Hi there from custom  ",
    );
    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));

    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [, opts] = bulkQueueSms.mock.calls[0];
    expect(opts.campaignName).toBe("Custom Campaign");
    expect(opts.body).toBe("Hi there from custom");
  });

  it("server-side duplicate campaign name errors stay inline on the field", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: false,
      error: {
        code: "DUPLICATE_NAME",
        message: 'A campaign named "June Vacant Homes" already exists.',
      },
    });
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    await fillCampaignName(user);
    await selectSender(user);

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));

    expect(
      await screen.findByText(
        'A campaign named "June Vacant Homes" already exists.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: /Campaign name/i }),
    ).toHaveFocus();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("deferred sends route to the job detail progress page", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: {
        succeeded: 0,
        skipped: 0,
        failed: [],
        deferred: { jobId: "job-123", total: 501 },
      },
    });
    renderModal(Array.from({ length: 501 }, (_, i) => `p${i}`));
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    await fillCampaignName(user);
    await selectSender(user);

    await user.click(
      screen.getByRole("button", { name: /Queue 501 messages/i }),
    );

    await waitFor(() =>
      expect(routerPush).toHaveBeenCalledWith("/jobs/job-123"),
    );
  });

  it("mode switching does not clear campaign name", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());

    await fillCampaignName(user, "Mode Stable");
    await user.click(screen.getByRole("button", { name: /Custom message/i }));
    await user.click(screen.getByRole("button", { name: /Template pool/i }));

    expect(screen.getByRole("textbox", { name: /Campaign name/i })).toHaveValue(
      "Mode Stable",
    );
  });
});

describe("<BulkSmsModal /> line-type assessment", () => {
  it("shows the mobile/landline/unknown breakdown from assessBulkSmsAudience", async () => {
    assessBulkSmsAudience.mockResolvedValue({
      ok: true,
      data: { total: 10, mobile: 6, landline: 3, unknown: 1, noPhone: 0 },
    });
    renderModal(Array.from({ length: 10 }, (_, i) => `p${i}`));

    await waitFor(() =>
      expect(screen.getByTestId("line-type-assessment")).toHaveTextContent(
        /6 mobile/,
      ),
    );
    expect(screen.getByTestId("line-type-assessment")).toHaveTextContent(
      /3 landline \(always excluded\)/,
    );
    expect(screen.getByTestId("line-type-assessment")).toHaveTextContent(
      /1 unknown/,
    );
  });

  it("queue button reflects mobile count only; unknown toggle adds unknowns and forwards includeUnknown", async () => {
    const user = userEvent.setup();
    assessBulkSmsAudience.mockResolvedValue({
      ok: true,
      data: { total: 5, mobile: 2, landline: 1, unknown: 2, noPhone: 0 },
    });
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 2, skipped: 3, failed: [] },
    });
    renderModal(["p1", "p2", "p3", "p4", "p5"]);

    // Mobiles only until opted in.
    const queueBtn = await screen.findByRole("button", {
      name: /Queue 2 messages/i,
    });
    await fillCampaignName(user);
    await selectSender(user);

    await user.click(
      screen.getByRole("checkbox", { name: /Also text 2 unknown/i }),
    );
    expect(
      screen.getByRole("button", { name: /Queue 4 messages/i }),
    ).toBeInTheDocument();

    await user.click(queueBtn);
    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [, opts] = bulkQueueSms.mock.calls[0];
    expect(opts.campaignName).toBe("June Vacant Homes");
    expect(opts.includeUnknown).toBe(true);
  });

  it("includeUnknown defaults to false in submitted opts", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    await fillCampaignName(user);
    await selectSender(user);

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));
    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [, opts] = bulkQueueSms.mock.calls[0];
    expect(opts.campaignName).toBe("June Vacant Homes");
    expect(opts.includeUnknown).toBe(false);
  });

  it("disables the queue button when nothing is textable", async () => {
    assessBulkSmsAudience.mockResolvedValue({
      ok: true,
      data: { total: 2, mobile: 0, landline: 2, unknown: 0, noPhone: 0 },
    });
    renderModal(["p1", "p2"]);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Queue 0 messages/i }),
      ).toBeDisabled(),
    );
  });
});

describe("<BulkSmsModal /> delivery setup", () => {
  it("blocks submit with 'Choose a sending number.' when no sender is selected", async () => {
    const user = userEvent.setup();
    renderModal(["p1"]);
    await waitFor(() => expect(listDeliveryOptions).toHaveBeenCalled());
    await fillCampaignName(user);

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));

    expect(screen.getByText("Choose a sending number.")).toBeInTheDocument();
    expect(bulkQueueSms).not.toHaveBeenCalled();
  });

  it("passes the selected sender and provider campaign to bulkQueueSms", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: true,
      data: { succeeded: 1, skipped: 0, failed: [] },
    });
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    await fillCampaignName(user);
    await selectSender(user);
    await user.selectOptions(
      screen.getByLabelText(/provider campaign \(optional\)/i),
      "pc-1",
    );

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));

    await waitFor(() => expect(bulkQueueSms).toHaveBeenCalled());
    const [, opts] = bulkQueueSms.mock.calls[0];
    expect(opts.senderNumber).toBe("+15551234567");
    expect(opts.providerCampaignExternalId).toBe("pc-1");
  });

  it("surfaces server SENDER_NOT_APPROVED errors on the sender field", async () => {
    const user = userEvent.setup();
    bulkQueueSms.mockResolvedValue({
      ok: false,
      error: {
        code: "SENDER_NOT_APPROVED",
        message:
          "Sending number is not in the synced approved sender list. Sync Delivery senders and pick an active number.",
      },
    });
    renderModal(["p1"]);
    await waitFor(() => expect(listSmsTemplateCategories).toHaveBeenCalled());
    await fillCampaignName(user);
    await selectSender(user);

    await user.click(screen.getByRole("button", { name: /Queue 1 message/i }));

    expect(
      await screen.findByText(/not in the synced approved sender list/i),
    ).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it("renders the empty-catalog sync hint with a Sync button when no senders are synced", async () => {
    listDeliveryOptions.mockResolvedValue({
      ok: true,
      data: {
        provider: "test-provider",
        senders: [],
        providerCampaigns: [],
        lastSyncedAt: null,
      },
    });
    renderModal(["p1"]);

    expect(
      await screen.findByText(/No approved sending numbers synced yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync" })).toBeInTheDocument();
  });
});

describe("computeDrain — uncapped continuous ramp", () => {
  // 2026-04-23T17:00:00Z == 9:00 AM PT at the fixed -08:00 offset the
  // preview math uses.
  const NINE_AM_PT = new Date("2026-04-23T17:00:00Z");

  it("counts quiet-window (9 PM – 8 AM PT) slots across EVERY night the ramp crosses", () => {
    // 30 messages at 1h pacing from 9 AM PT: slots land at 9 AM..8 PM
    // (sendable), 9 PM..7 AM (11 quiet slots), then 8 AM..2 PM next day
    // (sendable again).
    const drain = computeDrain({
      total: 30,
      paceSeconds: 3600,
      now: NINE_AM_PT,
    });
    expect(drain.pastCutoffCount).toBe(11);
    expect(drain.perDay).toEqual([{ dayLabel: "Queued", count: 30 }]);
  });

  it("reports zero quiet-window slots when the ramp finishes before 9 PM PT", () => {
    const drain = computeDrain({
      total: 10,
      paceSeconds: 8,
      now: NINE_AM_PT,
    });
    expect(drain.pastCutoffCount).toBe(0);
  });

  it("empty selection → empty preview", () => {
    expect(computeDrain({ total: 0, paceSeconds: 8, now: NINE_AM_PT })).toEqual(
      { perDay: [], lastSendLocal: null, pastCutoffCount: 0 },
    );
  });
});
