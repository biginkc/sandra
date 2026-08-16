import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { summarize, validateRow } from "@/lib/csv/validate";
import type { ImportPreflight } from "@/lib/csv/preflight";
import type { WizardState } from "../wizard";
import { StepConfirm } from "./step-confirm";
import { StepMap } from "./step-map";
import { StepPreflight } from "./step-preflight";
import { StepProgress } from "./step-progress";
import { StepReview } from "./step-review";

const { createClientMock, getCsvImportRetryAvailabilityMock } = vi.hoisted(
  () => ({
    createClientMock: vi.fn(),
    getCsvImportRetryAvailabilityMock: vi.fn().mockResolvedValue({
      ok: true,
      data: { state: "retryable", message: null },
    }),
  }),
);

vi.mock("@/lib/supabase/client", () => ({ createClient: createClientMock }));
vi.mock("../actions", () => ({
  retryCsvImportJob: vi.fn(),
  retryImportListAssignment: vi.fn(),
  getCsvImportRetryAvailability: getCsvImportRetryAvailabilityMock,
}));
vi.mock("@/app/(dashboard)/sequences/actions", () => ({
  listSequences: vi.fn().mockResolvedValue({ ok: true, data: [] }),
}));

const rows = [
  { Address: "1 Main St", State: "MO", __sandra_dnc_locked: "true" },
  { Address: "2 Main St", State: "MO", __sandra_dnc_locked: "true" },
];
const mapping = {
  address: "Address",
  state: "State",
  homeowner_do_not_contact: "__sandra_dnc_locked",
};
const groups: ImportPreflight["groups"] = {
  new: [],
  existing: [],
  blocked: [],
  warnings: [],
  dnc: [0, 1],
  smsSuppressed: [],
  duplicates: [],
  empty: [],
  malformed: [],
  noUsableContact: [],
};
const preflight: ImportPreflight = {
  total: 2,
  ready: 2,
  existingMatches: 0,
  inFileDuplicates: 0,
  empty: 0,
  malformed: 0,
  noUsableContact: 0,
  dnc: 2,
  smsSuppressed: 0,
  groups,
  dncReasons: { 0: ["File DNC"], 1: ["Existing opt-out"] },
  smsSuppressionReasons: {},
};
const validated = rows.map((row, index) => validateRow(row, mapping, index));
const state = {
  step: "review",
  mode: "add",
  subOperation: null,
  updatePreview: null,
  file: new File([""], "dnc.csv"),
  filename: "dnc.csv",
  source: "dealmachine",
  detectedPreset: null,
  presetApplied: false,
  prePresetSnapshot: null,
  presetStats: null,
  market: "Buchanan County MO",
  countyId: "county-1",
  listName: null,
  requestSkipTrace: false,
  requestCass: false,
  smsConsent: false,
  sequenceId: null,
  classifyLineTypes: false,
  preflight,
  headers: ["Address", "State", "__sandra_dnc_locked"],
  rows,
  mapping,
  summary: summarize(validated),
  previewRows: validated,
  jobId: null,
  submitting: false,
  error: null,
} satisfies WizardState;

describe("DNC count conservation across the import UI", () => {
  it("shows the same locked count in Preflight, Review, and Confirm", async () => {
    const user = userEvent.setup();
    const preflightView = render(<StepPreflight state={state} />);
    expect(
      screen.getByText(/2 Do-Not-Contact records detected/),
    ).toBeInTheDocument();
    preflightView.unmount();

    const reviewView = render(<StepReview state={state} dispatch={vi.fn()} />);
    await user.click(screen.getByRole("tab", { name: /DNC 2/ }));
    expect(screen.getAllByText("1 Main St").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2 Main St").length).toBeGreaterThan(0);
    reviewView.unmount();

    render(
      <StepConfirm state={state} dispatch={vi.fn()} unlabeledPhoneCount={0} />,
    );
    expect(screen.getByText("2 locked Prospects")).toBeInTheDocument();
  });

  it("renders the generated DNC mapping as non-editable", () => {
    render(<StepMap state={state} dispatch={vi.fn()} />);
    expect(
      screen.getByRole("combobox", { name: /Do Not Contact/i }),
    ).toBeDisabled();
  });

  it("shows the conserved count in terminal Results", async () => {
    const channel = {
      on: vi.fn(),
      subscribe: vi.fn(),
    };
    channel.on.mockReturnValue(channel);
    channel.subscribe.mockReturnValue(channel);
    const jobQuery = {
      select: vi.fn(),
      eq: vi.fn(),
      single: vi.fn().mockResolvedValue({
        data: {
          id: "job-1",
          status: "completed",
          total_items: 2,
          processed_items: 2,
          succeeded_items: 2,
          failed_items: 0,
          result_summary: { dncRows: 2, sideEffects: {} },
        },
        error: null,
      }),
    };
    jobQuery.select.mockReturnValue(jobQuery);
    jobQuery.eq.mockReturnValue(jobQuery);
    createClientMock.mockReturnValue({
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: null } }),
      },
      realtime: { setAuth: vi.fn() },
      channel: vi.fn().mockReturnValue(channel),
      removeChannel: vi.fn(),
      from: vi.fn().mockReturnValue(jobQuery),
    });

    render(<StepProgress jobId="job-1" />);
    await waitFor(() => {
      expect(
        screen.getByText(/2 Do-Not-Contact records imported locked/),
      ).toBeInTheDocument();
    });
  });

  it("offers retry after a zero-row workflow-start failure when sealed provenance exists", async () => {
    const channel = { on: vi.fn(), subscribe: vi.fn() };
    channel.on.mockReturnValue(channel);
    channel.subscribe.mockReturnValue(channel);
    const chain = (result: unknown) => {
      const query = {
        select: vi.fn(),
        eq: vi.fn(),
        single: vi.fn().mockResolvedValue(result),
        maybeSingle: vi.fn().mockResolvedValue(result),
      };
      query.select.mockReturnValue(query);
      query.eq.mockReturnValue(query);
      return query;
    };
    createClientMock.mockReturnValue({
      auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null } }) },
      realtime: { setAuth: vi.fn() },
      channel: vi.fn().mockReturnValue(channel),
      removeChannel: vi.fn(),
      from: vi.fn((table: string) =>
        table === "jobs"
          ? chain({
              data: {
                id: "job-zero",
                org_id: "org-1",
                type: "csv_import",
                status: "failed",
                error_class: "configuration",
                total_items: 20,
                processed_items: 0,
                succeeded_items: 0,
                failed_items: 0,
                result_summary: { sideEffects: {} },
              },
              error: null,
            })
          : chain({ data: { job_id: "job-zero" }, error: null }),
      ),
    });

    render(<StepProgress jobId="job-zero" />);
    expect(
      await screen.findByRole("button", { name: "Retry import" }),
    ).toBeVisible();
  });
});
