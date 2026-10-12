// GET /api/push/dispatch
import { jsonResponse } from "../../_lib/db.js";
import { sendDueNewOrderPushes } from "../../_lib/push.js";

export async function onRequestGet(context) {
  const origin = new URL(context.request.url).origin;
  const sent = await sendDueNewOrderPushes(context.env, { origin });
  return jsonResponse({ success: true, sent });
}
