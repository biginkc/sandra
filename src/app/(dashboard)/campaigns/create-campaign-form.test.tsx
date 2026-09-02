import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BlockOptions } from "@/app/(dashboard)/properties/_components/blocks/_block-shell";
import { EMPTY_AUDIENCE_VALIDATION_MESSAGE } from "@/lib/prospects/effective-audience";

import { CreateCampaignForm } from "./create-campaign-form";

const {
  createCampaign,
  listDeliveryOptions,
  refreshDeliveryCatalog,
  routerRefresh,
  callAction,
} = vi.hoisted(() => ({
  createCampaign: vi.fn(),
  listDeliveryOptions: vi.fn(),
  refreshDeliveryCatalog: vi.fn(),
  routerRefresh: vi.fn(),
  callAction: vi.fn((promise: Promise<unknown>) => promise),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    refresh: routerRefresh,
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("./actions", () => ({
  createCampaign: (...args: unknown[]) => createCampaign(...args),
  listDeliveryOptions: (...args: unknown[]) => listDeliveryOptions(...args),
  refreshDeliveryCatalog: (...args: unknown[]) =>
    refreshDeliveryCatalog(...args),
}));

vi.mock("@/lib/errors/call-action", () => ({
  callAction: (...args: Parameters<typeof callAction>) => callAction(...args),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

const blockOptions: BlockOptions = {
  lists: [{ id: "l1", name: "Vacant Land" }],
  tags: [{ id: "t1", name: "Hot Lead" }],
  markets: ["KC"],
  states: ["MO"],
  assignees: [{ id: "u1", email: "agent@bmhgroupkc.com" }],
  sources: ["dealmachine"],
  pipelineStatuses: ["prospect", "contacted"],
  motivationLevels: ["hot", "warm", "cold"],
  outreachDispos: ["callback_requested"],
  cassStatuses: ["verified", "unverified"],
};

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

function renderForm() {
  return render(
    <CreateCampaignForm
      blockOptions={blockOptions}
      templateCategories={[{ category: "Opener - Homeowner", count: 3 }]}
    />,
  );
}

async function addVacancyAudience(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /add filter/i }));
  await user.click(await screen.findByRole("button", { name: "Vacancy" }));
  await screen.findByText("Vacancy");
  await user.click(screen.getByText("Yes (vacant)"));
}

async function addNoOpVacancyFilter(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /add filter/i }));
  await user.click(await screen.findByRole("button", { name: "Vacancy" }));
  await screen.findByText("Vacancy");
}

async function selectSender(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("option", { name: /number ending 4567/i });
  await user.selectOptions(
    screen.getByLabelText(/sending number/i),
    "+15551234567",
  );
}

beforeEach(() => {
  createCampaign.mockReset();
  listDeliveryOptions.mockReset();
  refreshDeliveryCatalog.mockReset();
  routerRefresh.mockReset();
  callAction.mockClear();
  callAction.mockImplementation((promise: Promise<unknown>) => promise);

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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("<CreateCampaignForm />", () => {
  it("shows a name validation error instead of submitting an unnamed campaign", async () => {
    const user = userEvent.setup();
    createCampaign.mockResolvedValue({ ok: true, data: { id: "camp-1" } });

    renderForm();

    await user.type(
      screen.getByLabelText(/message body/i),
      "Hello from Sandra",
    );
    await addVacancyAudience(user);
    await user.click(
      screen.getByRole("button", { name: /create campaign/i }),
    );

    expect(createCampaign).not.toHaveBeenCalled();
    expect(
      screen.getByText("Campaign name is required."),
    ).toBeInTheDocument();
  });

  it("captures the saved audience plus body, pacing, and skip-contacted fields", async () => {
    const user = userEvent.setup();
    createCampaign.mockResolvedValue({ ok: true, data: { id: "camp-2" } });

    renderForm();

    await user.type(screen.getByLabelText(/^name$/i), "Vacant June");
    await user.type(
      screen.getByLabelText(/message body/i),
      "Checking in about your property.",
    );
    await user.clear(screen.getByLabelText(/pacing \(seconds\)/i));
    await user.type(screen.getByLabelText(/pacing \(seconds\)/i), "45");
    await user.click(
      screen.getByRole("checkbox", {
        name: /skip prospects already contacted/i,
      }),
    );
    await user.type(
      screen.getByLabelText(/search prospects/i),
      "oak",
    );
    await addVacancyAudience(user);
    await selectSender(user);

    await user.click(
      screen.getByRole("button", { name: /create campaign/i }),
    );

    await waitFor(() => expect(createCampaign).toHaveBeenCalledTimes(1));
    expect(createCampaign).toHaveBeenCalledWith({
      name: "Vacant June",
      body: "Checking in about your property.",
      templateCategory: null,
      paceSeconds: 45,
      skipIfContacted: true,
      senderNumber: "+15551234567",
      providerCampaignExternalId: null,
      audience: {
        search: "oak",
        blockStack: [
          expect.objectContaining({
            kind: "vacancy",
            tri: "yes",
          }),
        ],
      },
    });
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("blocks invalid pacing before the server action runs", async () => {
    const user = userEvent.setup();
    createCampaign.mockResolvedValue({ ok: true, data: { id: "camp-3" } });

    renderForm();

    await user.type(screen.getByLabelText(/^name$/i), "Too Fast");
    await user.type(screen.getByLabelText(/message body/i), "Fast blast");
    await addVacancyAudience(user);
    await user.clear(screen.getByLabelText(/pacing \(seconds\)/i));
    await user.type(screen.getByLabelText(/pacing \(seconds\)/i), "1");

    await user.click(
      screen.getByRole("button", { name: /create campaign/i }),
    );

    expect(createCampaign).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "Saved campaign pacing must be between 2 seconds and 10 minutes.",
      ),
    ).toBeInTheDocument();
  });

  it("blocks a no-op audience filter before the server action runs", async () => {
    const user = userEvent.setup();
    createCampaign.mockResolvedValue({ ok: true, data: { id: "camp-4" } });

    renderForm();

    await user.type(screen.getByLabelText(/^name$/i), "No-op Audience");
    await user.type(screen.getByLabelText(/message body/i), "Hello there");
    await addNoOpVacancyFilter(user);

    await user.click(
      screen.getByRole("button", { name: /create campaign/i }),
    );

    expect(createCampaign).not.toHaveBeenCalled();
    expect(
      screen.getByText(EMPTY_AUDIENCE_VALIDATION_MESSAGE),
    ).toBeInTheDocument();
  });

  it("blocks submit with a delivery error when no sender is selected", async () => {
    const user = userEvent.setup();
    createCampaign.mockResolvedValue({ ok: true, data: { id: "camp-5" } });

    renderForm();

    await user.type(screen.getByLabelText(/^name$/i), "No Sender");
    await user.type(screen.getByLabelText(/message body/i), "Hello there");
    await addVacancyAudience(user);
    // Catalog loaded but no sender chosen.
    await screen.findByRole("option", { name: /number ending 4567/i });

    await user.click(
      screen.getByRole("button", { name: /create campaign/i }),
    );

    expect(createCampaign).not.toHaveBeenCalled();
    expect(
      screen.getByText("Choose a sending number."),
    ).toBeInTheDocument();
  });

  it("passes the selected sender and provider campaign to createCampaign", async () => {
    const user = userEvent.setup();
    createCampaign.mockResolvedValue({ ok: true, data: { id: "camp-6" } });

    renderForm();

    await user.type(screen.getByLabelText(/^name$/i), "With Delivery");
    await user.type(screen.getByLabelText(/message body/i), "Hello there");
    await addVacancyAudience(user);
    await selectSender(user);
    await user.selectOptions(
      screen.getByLabelText(/provider campaign \(optional\)/i),
      "pc-1",
    );

    await user.click(
      screen.getByRole("button", { name: /create campaign/i }),
    );

    await waitFor(() => expect(createCampaign).toHaveBeenCalledTimes(1));
    expect(createCampaign).toHaveBeenCalledWith(
      expect.objectContaining({
        senderNumber: "+15551234567",
        providerCampaignExternalId: "pc-1",
      }),
    );
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

    renderForm();

    expect(
      await screen.findByText(/No approved sending numbers synced yet/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sync" })).toBeInTheDocument();
  });
});
