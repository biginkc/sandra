import type { KnownBlock } from "@slack/types";

export interface TaskAssignedBlockInput {
  taskTitle: string;
  propertyAddress: string;
  dueLabel: string;
  taskTypeLabel: string;
  taskId: string;
  deepLink: string;
  /** Lead page URL: when set, the address text becomes the link (same words). */
  leadLink?: string | null;
}

export interface MarkedDoneBlockInput {
  taskTitle: string;
  propertyAddress: string;
  doneByUserName: string;
  deepLink: string;
  leadLink?: string | null;
}

const escapeMrkdwn = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The address as mrkdwn: a link to the lead when one is given, else unchanged. */
function addressText(address: string, leadLink?: string | null): string {
  return leadLink ? `<${leadLink}|${escapeMrkdwn(address)}>` : address;
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
          text: addressText(input.propertyAddress, input.leadLink),
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

export interface AppointmentReminderBlockInput {
  taskTitle: string;
  /** Wall-clock time-of-day in the assignee's zone, e.g. "3:00 PM CDT". */
  timeLabel: string;
  deepLink: string;
}

/**
 * PR 3 reminder sweep — same header + context shape as
 * `buildTaskAssignedBlocks` but no "Mark Done" action row: a reminder is
 * informational, not an assignment the recipient needs to act on from
 * Slack.
 */
export function buildAppointmentReminderBlocks(
  input: AppointmentReminderBlockInput,
): KnownBlock[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `Appointment in 30 min: ${input.taskTitle}`,
        emoji: true,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `*${input.timeLabel}* · <${input.deepLink}|Open in Sandra>`,
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
          text: addressText(input.propertyAddress, input.leadLink),
        },
      ],
    },
  ];
}
