import type { KnownBlock } from "@slack/types";

export interface TaskAssignedBlockInput {
  taskTitle: string;
  propertyAddress: string;
  dueLabel: string;
  taskTypeLabel: string;
  taskId: string;
  deepLink: string;
}

export interface MarkedDoneBlockInput {
  taskTitle: string;
  propertyAddress: string;
  doneByUserName: string;
  deepLink: string;
}

/**
 * Caller owns truncating taskTitle to Slack's practical header limit.
 */
export function buildTaskAssignedBlocks(
  input: TaskAssignedBlockInput,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Task assigned: ${input.taskTitle}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${input.taskTypeLabel}* · Due ${input.dueLabel} · <${input.deepLink}|Open in Sandra>`,
        },
        {
          type: "mrkdwn",
          text: input.propertyAddress,
        },
      ],
    },
    {
      type: "actions",
      block_id: "task_actions",
      elements: [
        {
          type: "button",
          action_id: "mark_done",
          style: "primary",
          value: input.taskId,
          text: {
            type: "plain_text",
            text: "Mark Done",
            emoji: true,
          },
        },
      ],
    },
  ];
}

export function buildMarkedDoneBlocks(
  input: MarkedDoneBlockInput,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `✓ Marked done: ${input.taskTitle}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Done by ${input.doneByUserName} · <${input.deepLink}|Open in Sandra>`,
        },
        {
          type: "mrkdwn",
          text: input.propertyAddress,
        },
      ],
    },
  ];
}
