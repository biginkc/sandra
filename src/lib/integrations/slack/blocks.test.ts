import { describe, it, expect } from "vitest";

import {
  buildAppointmentReminderBlocks,
  buildMarkedDoneBlocks,
  buildTaskAssignedBlocks,
} from "./blocks";

const fixture = {
  taskTitle: "Call the owner",
  propertyAddress: "123 Slack Test Ln",
  dueLabel: "tomorrow",
  taskTypeLabel: "Callback",
  taskId: "11111111-1111-4111-8111-111111111111",
  deepLink: "https://sandra-sooty.vercel.app/tasks/11111111-1111-4111-8111-111111111111",
};

describe("slack/blocks", () => {
  it("buildTaskAssignedBlocks returns header + context + actions blocks", () => {
    const blocks = buildTaskAssignedBlocks(fixture);

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({ type: "header" });
    expect(blocks[1]).toMatchObject({ type: "context" });
    expect(blocks[2]).toMatchObject({ type: "actions" });
  });

  it("renders the task title in the header", () => {
    expect(buildTaskAssignedBlocks(fixture)[0]).toMatchObject({
      text: { text: "Task assigned: Call the owner" },
    });
  });

  it("renders type, due label, and Sandra deep link in the first context item", () => {
    expect(buildTaskAssignedBlocks(fixture)[1]).toMatchObject({
      elements: [
        expect.objectContaining({
          text: `*Callback* · Due tomorrow · <${fixture.deepLink}|Open in Sandra>`,
        }),
        expect.any(Object),
      ],
    });
  });

  it("renders the property address in the second context item", () => {
    expect(buildTaskAssignedBlocks(fixture)[1]).toMatchObject({
      elements: [expect.any(Object), { text: "123 Slack Test Ln" }],
    });
  });

  it("button action_id === 'mark_done' and value === taskId", () => {
    expect(buildTaskAssignedBlocks(fixture)[2]).toMatchObject({
      block_id: "task_actions",
      elements: [
        {
          type: "button",
          action_id: "mark_done",
          style: "primary",
          value: fixture.taskId,
          text: { text: "Mark Done" },
        },
      ],
    });
  });

  it("buildMarkedDoneBlocks removes the actions block", () => {
    const blocks = buildMarkedDoneBlocks({
      taskTitle: fixture.taskTitle,
      propertyAddress: fixture.propertyAddress,
      doneByUserName: "Jarrad",
      deepLink: fixture.deepLink,
    });

    expect(blocks).toHaveLength(2);
    expect(blocks.some((block) => (block as { type?: string }).type === "actions")).toBe(false);
  });

  it("buildMarkedDoneBlocks renders completion context", () => {
    expect(
      buildMarkedDoneBlocks({
        taskTitle: fixture.taskTitle,
        propertyAddress: fixture.propertyAddress,
        doneByUserName: "Jarrad",
        deepLink: fixture.deepLink,
      }),
    ).toMatchObject([
      { type: "header", text: { text: "✓ Marked done: Call the owner" } },
      {
        type: "context",
        elements: [
          { text: `Done by Jarrad · <${fixture.deepLink}|Open in Sandra>` },
          { text: "123 Slack Test Ln" },
        ],
      },
    ]);
  });

  it("buildAppointmentReminderBlocks returns header + context, no actions block", () => {
    const blocks = buildAppointmentReminderBlocks({
      taskTitle: "Walkthrough with seller",
      timeLabel: "3:00 PM CDT",
      deepLink: fixture.deepLink,
    });

    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({
      type: "header",
      text: { text: "Appointment in 30 min: Walkthrough with seller" },
    });
    expect(blocks[1]).toMatchObject({
      type: "context",
      elements: [
        { text: `*3:00 PM CDT* · <${fixture.deepLink}|Open in Sandra>` },
      ],
    });
    expect(blocks.some((block) => (block as { type?: string }).type === "actions")).toBe(false);
  });

  it("snapshot matches a known-good fixture for follow-up + due tomorrow", () => {
    expect(buildTaskAssignedBlocks(fixture)).toMatchInlineSnapshot(`
      [
        {
          "text": {
            "emoji": true,
            "text": "Task assigned: Call the owner",
            "type": "plain_text",
          },
          "type": "header",
        },
        {
          "elements": [
            {
              "text": "*Callback* · Due tomorrow · <https://sandra-sooty.vercel.app/tasks/11111111-1111-4111-8111-111111111111|Open in Sandra>",
              "type": "mrkdwn",
            },
            {
              "text": "123 Slack Test Ln",
              "type": "mrkdwn",
            },
          ],
          "type": "context",
        },
        {
          "block_id": "task_actions",
          "elements": [
            {
              "action_id": "mark_done",
              "style": "primary",
              "text": {
                "emoji": true,
                "text": "Mark Done",
                "type": "plain_text",
              },
              "type": "button",
              "value": "11111111-1111-4111-8111-111111111111",
            },
          ],
          "type": "actions",
        },
      ]
    `);
  });
});
