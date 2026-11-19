/**
 * Hold reasons for the "where did you get my number" reply. Kept out of
 * `template-reply.ts` so the constants are identical everywhere they are read
 * (dispatch, hold alerts, tests).
 *
 * - awaiting_answer: the approved reply went out and asks "want me to take you
 *   off the list?". The property is flagged so the seller's next answer is
 *   seen by a person (nothing is suppressed automatically).
 * - not_sent: Jev said the seller asked, but the approved reply did not go out
 *   (unmapped/unapproved template, render failure, outbound hold, recipient
 *   window, or an outcome that never gets a reply). No other template is sent
 *   in its place; a person looks. The tail is the reason.
 * - answer_received: a new inbound arrived while the awaiting_answer hold was
 *   open; the hold is refreshed instead of the message being silently skipped.
 */
export const NUMBER_SOURCE_AWAITING_ANSWER_REASON = "number_source_awaiting_answer";
export const NUMBER_SOURCE_ANSWER_RECEIVED_REASON = "number_source_answer_received";
export const NUMBER_SOURCE_NOT_SENT_PREFIX = "number_source_reply_not_sent:";
