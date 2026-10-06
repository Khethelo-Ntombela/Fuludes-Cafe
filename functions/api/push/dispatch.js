/**
 * functions/api/push/dispatch.js
 * -----------------------------------------------------------------------
 * GET /api/push/dispatch
 * Sends any "new paid order" notifications that are due (orders whose
 * 2-minute cancel window has ended - see sendDueNewOrderPushes in
 * functions/_lib/push.js). The admin/staff boards and the customer's My
 * Orders page already trigger this every few seconds; this URL is the
 * backup for when nobody has the site open - point a free once-a-minute
 * cron (e.g. cron-job.org) at it.
 *
 * Safe to call by anyone, any number of times: each order is claimed once,
 * so it can only send what was going to be sent anyway.
 * -----------------------------------------------------------------------
 */
import { jsonResponse } from "../../_lib/db.js";
import { sendDueNewOrderPushes } from "../../_lib/push.js";

export async function onRequestGet(context) {
  const origin = new URL(context.request.url).origin;
  const sent = await sendDueNewOrderPushes(context.env, { origin });
  return jsonResponse({ success: true, sent });
}
