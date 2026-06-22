/**
 * RTL smoke tests for all 23 filter-block components.
 * Each describe block verifies:
 *   1. Renders with the kind label visible
 *   2. Interaction fires onChange with a correct partial patch
 *   3. Clicking × fires onRemove
 */

import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { BlockOptionsContext, type BlockOptions } from "./_block-shell";

// ---------------------------------------------------------------------------
// Shared mock options — provided via BlockOptionsContext.Provider
// ---------------------------------------------------------------------------
const opts: BlockOptions = {
  lists: [{ id: "l1", name: "Buyers List" }],
  tags: [{ id: "t1", name: "Hot Lead" }],
  markets: ["KC, MO"],
  states: ["MO", "KS"],
  assignees: [{ id: "u1", email: "agent@bmh.com" }],
  sources: ["dealmachine", "csv"],
  pipelineStatuses: ["prospect", "lead", "contract", "closed"],
  motivationLevels: ["high", "medium", "low"],
  outreachDispos: ["nurture", "needs_sequence", "not_interested"],
  cassStatuses: ["verified", "unverified", "invalid", "ambiguous"],
};

function wrap(node: React.ReactNode) {
  return render(
    <BlockOptionsContext.Provider value={opts}>
      {node}
    </BlockOptionsContext.Provider>,
  );
}

function clickRemove(label: string) {
  fireEvent.click(screen.getByRole("button", { name: `Remove ${label} filter` }));
}

// ---------------------------------------------------------------------------
// Lazy imports — each block is a default export
// ---------------------------------------------------------------------------
import ListBlock from "./list-block";
import TagBlock from "./tag-block";
import ListCountBlock from "./list-count-block";
import VacancyBlock from "./vacancy-block";
import CassBlock from "./cass-block";
import OutreachDispoBlock from "./outreach-dispo-block";
import SourceBlock from "./source-block";
import BedsBlock from "./beds-block";
import BathsBlock from "./baths-block";
import YearBuiltBlock from "./year-built-block";
import StateBlock from "./state-block";
import MarketBlock from "./market-block";
import AbsenteeBlock from "./absentee-block";
import EstimatedValueBlock from "./estimated-value-block";
import EquityPctBlock from "./equity-pct-block";
import PipelineStatusBlock from "./pipeline-status-block";
import EngagementBlock from "./engagement-block";
import AssigneeBlock from "./assignee-block";
import CreatedDateBlock from "./created-date-block";
import HasUnreadInboundBlock from "./has-unread-inbound-block";
import NeedsHumanAttentionBlock from "./needs-human-attention-block";
import HasOpenTasksBlock from "./has-open-tasks-block";
import MotivationLevelBlock from "./motivation-level-block";

// ---------------------------------------------------------------------------
// 1. list-block
// ---------------------------------------------------------------------------
describe("list-block", () => {
  const base = { id: "b1", kind: "list" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    const onChange = vi.fn();
    wrap(<ListBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    expect(screen.getByText("List")).toBeInTheDocument();
  });

  it("onChange fires when a list item is checked", () => {
    const onChange = vi.fn();
    wrap(<ListBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /buyers list/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["l1"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<ListBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("List");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 2. tag-block
// ---------------------------------------------------------------------------
describe("tag-block", () => {
  const base = { id: "b2", kind: "tag" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    wrap(<TagBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Tag")).toBeInTheDocument();
  });

  it("onChange fires when a tag is checked", () => {
    const onChange = vi.fn();
    wrap(<TagBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /hot lead/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["t1"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<TagBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Tag");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. list-count-block
// ---------------------------------------------------------------------------
describe("list-count-block", () => {
  const base = { id: "b3", kind: "list_count" as const, range: { min: null, max: null } };

  it("renders with the kind label", () => {
    wrap(<ListCountBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("List Count")).toBeInTheDocument();
  });

  it("onChange fires when min input changes", () => {
    const onChange = vi.fn();
    wrap(<ListCountBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Minimum list count"), { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ range: { min: 2, max: null } }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<ListCountBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("List Count");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. vacancy-block
// ---------------------------------------------------------------------------
describe("vacancy-block", () => {
  const base = { id: "b4", kind: "vacancy" as const, tri: "any" as const };

  it("renders with the kind label", () => {
    wrap(<VacancyBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Vacancy")).toBeInTheDocument();
  });

  it("onChange fires when Yes radio is clicked", () => {
    const onChange = vi.fn();
    wrap(<VacancyBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    // RadioGroup uses data-checked; fire click on the radio item
    fireEvent.click(screen.getByText("Yes (vacant)"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tri: "yes" }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<VacancyBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Vacancy");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 5. cass-block
// ---------------------------------------------------------------------------
describe("cass-block", () => {
  const base = { id: "b5", kind: "cass" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    wrap(<CassBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("CASS")).toBeInTheDocument();
  });

  it("onChange fires when a status is checked", () => {
    const onChange = vi.fn();
    wrap(<CassBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "verified" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["verified"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<CassBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("CASS");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 6. outreach-dispo-block
// ---------------------------------------------------------------------------
describe("outreach-dispo-block", () => {
  const base = { id: "b6", kind: "outreach_dispo" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    wrap(<OutreachDispoBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Outreach Disposition")).toBeInTheDocument();
  });

  it("onChange fires when a dispo is checked", () => {
    const onChange = vi.fn();
    wrap(<OutreachDispoBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Follow up" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["nurture"] }));
  });

  it("renders operator labels for non-obvious disposition values", () => {
    wrap(<OutreachDispoBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByRole("checkbox", { name: "Follow up" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Needs sequence" })).toBeInTheDocument();
    expect(screen.queryByText("nurture")).not.toBeInTheDocument();
    expect(screen.queryByText("needs_sequence")).not.toBeInTheDocument();
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<OutreachDispoBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Outreach Disposition");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 7. source-block
// ---------------------------------------------------------------------------
describe("source-block", () => {
  const base = { id: "b7", kind: "source" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    wrap(<SourceBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Source")).toBeInTheDocument();
  });

  it("onChange fires when a source is checked", () => {
    const onChange = vi.fn();
    wrap(<SourceBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /dealmachine/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["dealmachine"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<SourceBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Source");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 8. beds-block
// ---------------------------------------------------------------------------
describe("beds-block", () => {
  const base = { id: "b8", kind: "beds" as const, range: { min: null, max: null } };

  it("renders with the kind label", () => {
    wrap(<BedsBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Beds")).toBeInTheDocument();
  });

  it("onChange fires when min input changes", () => {
    const onChange = vi.fn();
    wrap(<BedsBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Minimum beds"), { target: { value: "3" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ range: { min: 3, max: null } }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<BedsBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Beds");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 9. baths-block
// ---------------------------------------------------------------------------
describe("baths-block", () => {
  const base = { id: "b9", kind: "baths" as const, range: { min: null, max: null } };

  it("renders with the kind label", () => {
    wrap(<BathsBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Baths")).toBeInTheDocument();
  });

  it("onChange fires when min input changes", () => {
    const onChange = vi.fn();
    wrap(<BathsBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Minimum baths"), { target: { value: "2" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ range: { min: 2, max: null } }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<BathsBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Baths");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 10. year-built-block
// ---------------------------------------------------------------------------
describe("year-built-block", () => {
  const base = { id: "b10", kind: "year_built" as const, range: { min: null, max: null } };

  it("renders with the kind label", () => {
    wrap(<YearBuiltBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Year Built")).toBeInTheDocument();
  });

  it("onChange fires when min input changes", () => {
    const onChange = vi.fn();
    wrap(<YearBuiltBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Minimum year built"), { target: { value: "1990" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ range: { min: 1990, max: null } }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<YearBuiltBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Year Built");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 11. state-block
// ---------------------------------------------------------------------------
describe("state-block", () => {
  const base = { id: "b11", kind: "state" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    wrap(<StateBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("State")).toBeInTheDocument();
  });

  it("onChange fires when a state is checked", () => {
    const onChange = vi.fn();
    wrap(<StateBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "MO" }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["MO"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<StateBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("State");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 12. market-block
// ---------------------------------------------------------------------------
describe("market-block", () => {
  const base = { id: "b12", kind: "market" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    wrap(<MarketBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Market")).toBeInTheDocument();
  });

  it("onChange fires when a market is checked", () => {
    const onChange = vi.fn();
    wrap(<MarketBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /KC, MO/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["KC, MO"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<MarketBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Market");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 13. absentee-block
// ---------------------------------------------------------------------------
describe("absentee-block", () => {
  const base = { id: "b13", kind: "absentee" as const, tri: "any" as const };

  it("renders with the kind label", () => {
    wrap(<AbsenteeBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Absentee Owner")).toBeInTheDocument();
  });

  it("onChange fires when Yes radio is clicked", () => {
    const onChange = vi.fn();
    wrap(<AbsenteeBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByText("Yes (absentee)"));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tri: "yes" }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<AbsenteeBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Absentee Owner");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 14. estimated-value-block
// ---------------------------------------------------------------------------
describe("estimated-value-block", () => {
  const base = { id: "b14", kind: "estimated_value" as const, range: { min: null, max: null } };

  it("renders with the kind label", () => {
    wrap(<EstimatedValueBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Estimated Value")).toBeInTheDocument();
  });

  it("onChange fires when min input changes", () => {
    const onChange = vi.fn();
    wrap(<EstimatedValueBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Minimum estimated value"), { target: { value: "100000" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ range: { min: 100000, max: null } }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<EstimatedValueBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Estimated Value");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 15. equity-pct-block
// ---------------------------------------------------------------------------
describe("equity-pct-block", () => {
  const base = { id: "b15", kind: "equity_pct" as const, range: { min: null, max: null } };

  it("renders with the kind label", () => {
    wrap(<EquityPctBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Equity %")).toBeInTheDocument();
  });

  it("onChange fires when min input changes", () => {
    const onChange = vi.fn();
    wrap(<EquityPctBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Minimum equity percent"), { target: { value: "30" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ range: { min: 30, max: null } }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<EquityPctBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Equity %");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 16. pipeline-status-block
// ---------------------------------------------------------------------------
describe("pipeline-status-block", () => {
  const base = { id: "b16", kind: "pipeline_status" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    const onChange = vi.fn();
    wrap(<PipelineStatusBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    expect(screen.getByText("Pipeline Status")).toBeInTheDocument();
  });

  it("auto-prefills 'prospect' on mount when values is empty", () => {
    const onChange = vi.fn();
    wrap(<PipelineStatusBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["prospect"] }));
  });

  it("onChange fires when a status is toggled", () => {
    const onChange = vi.fn();
    const withProspect = { ...base, values: ["prospect"] };
    wrap(<PipelineStatusBlock block={withProspect} onChange={onChange} onRemove={vi.fn()} />);
    // Lead checkbox — toggle on
    fireEvent.click(screen.getByRole("checkbox", { name: /lead/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["prospect", "lead"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<PipelineStatusBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Pipeline Status");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 17. engagement-block
// ---------------------------------------------------------------------------
describe("engagement-block", () => {
  const base = { id: "b17", kind: "engagement" as const, combinator: "any" as const, values: [] as ("never_contacted" | "attempted" | "replied" | "opted_out")[] };

  it("renders with the kind label", () => {
    wrap(<EngagementBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Engagement")).toBeInTheDocument();
  });

  it("renders all 4 hardcoded buckets", () => {
    wrap(<EngagementBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Never contacted")).toBeInTheDocument();
    expect(screen.getByText("Attempted")).toBeInTheDocument();
    expect(screen.getByText("Replied")).toBeInTheDocument();
    expect(screen.getByText("Opted out")).toBeInTheDocument();
  });

  it("onChange fires when a bucket is checked", () => {
    const onChange = vi.fn();
    wrap(<EngagementBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /never contacted/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["never_contacted"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<EngagementBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Engagement");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 18. assignee-block
// ---------------------------------------------------------------------------
describe("assignee-block", () => {
  const base = { id: "b18", kind: "assignee" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    wrap(<AssigneeBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Assignee")).toBeInTheDocument();
  });

  it("renders 'Unassigned' pseudo-option", () => {
    wrap(<AssigneeBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("onChange fires with sentinel 'unassigned' when Unassigned is checked", () => {
    const onChange = vi.fn();
    wrap(<AssigneeBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /unassigned/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["unassigned"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<AssigneeBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Assignee");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 19. created-date-block
// ---------------------------------------------------------------------------
describe("created-date-block", () => {
  const base = { id: "b19", kind: "created_date" as const, date: { mode: "fixed" as const, from: null, to: null } };

  it("renders with the kind label", () => {
    wrap(<CreatedDateBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Created Date")).toBeInTheDocument();
  });

  it("renders fixed mode inputs by default", () => {
    wrap(<CreatedDateBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByLabelText("From date")).toBeInTheDocument();
    expect(screen.getByLabelText("To date")).toBeInTheDocument();
  });

  it("onChange fires when mode is changed to 'since'", () => {
    const onChange = vi.fn();
    wrap(<CreatedDateBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Date mode"), { target: { value: "since" } });
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ date: { mode: "since", days: 30 } }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<CreatedDateBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Created Date");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 20. has-unread-inbound-block
// ---------------------------------------------------------------------------
describe("has-unread-inbound-block", () => {
  const base = { id: "b20", kind: "has_unread_inbound" as const, tri: "any" as const };

  it("renders with the kind label", () => {
    wrap(<HasUnreadInboundBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Has Unread Inbound")).toBeInTheDocument();
  });

  it("onChange fires when Yes is clicked", () => {
    const onChange = vi.fn();
    wrap(<HasUnreadInboundBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    // Label text "Yes" — click it (label triggers radio)
    const yesLabels = screen.getAllByText("Yes");
    fireEvent.click(yesLabels[0]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tri: "yes" }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<HasUnreadInboundBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Has Unread Inbound");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 21. needs-human-attention-block
// ---------------------------------------------------------------------------
describe("needs-human-attention-block", () => {
  const base = { id: "b21", kind: "needs_human_attention" as const, tri: "any" as const };

  it("renders with the kind label", () => {
    wrap(<NeedsHumanAttentionBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Needs Human Attention")).toBeInTheDocument();
  });

  it("onChange fires when Yes is clicked", () => {
    const onChange = vi.fn();
    wrap(<NeedsHumanAttentionBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    const yesLabels = screen.getAllByText("Yes");
    fireEvent.click(yesLabels[0]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tri: "yes" }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<NeedsHumanAttentionBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Needs Human Attention");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 22. has-open-tasks-block
// ---------------------------------------------------------------------------
describe("has-open-tasks-block", () => {
  const base = { id: "b22", kind: "has_open_tasks" as const, tri: "any" as const };

  it("renders with the kind label", () => {
    wrap(<HasOpenTasksBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Has Open Tasks")).toBeInTheDocument();
  });

  it("onChange fires when Yes is clicked", () => {
    const onChange = vi.fn();
    wrap(<HasOpenTasksBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    const yesLabels = screen.getAllByText("Yes");
    fireEvent.click(yesLabels[0]);
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ tri: "yes" }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<HasOpenTasksBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Has Open Tasks");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 23. motivation-level-block
// ---------------------------------------------------------------------------
describe("motivation-level-block", () => {
  const base = { id: "b23", kind: "motivation_level" as const, combinator: "any" as const, values: [] };

  it("renders with the kind label", () => {
    wrap(<MotivationLevelBlock block={base} onChange={vi.fn()} onRemove={vi.fn()} />);
    expect(screen.getByText("Motivation Level")).toBeInTheDocument();
  });

  it("onChange fires when a level is checked", () => {
    const onChange = vi.fn();
    wrap(<MotivationLevelBlock block={base} onChange={onChange} onRemove={vi.fn()} />);
    fireEvent.click(screen.getByRole("checkbox", { name: /high/i }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ values: ["high"] }));
  });

  it("onRemove fires when × clicked", () => {
    const onRemove = vi.fn();
    wrap(<MotivationLevelBlock block={base} onChange={vi.fn()} onRemove={onRemove} />);
    clickRemove("Motivation Level");
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
