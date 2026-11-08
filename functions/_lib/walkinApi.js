// Request handling shared by /api/staff/walkin and /api/admin/walkin (the same screen is used in both places).
import { jsonResponse } from "./db.js";
import { queueDueNewOrderPushes } from "./push.js";
import { WalkinError, createWalkinOrder, listOpenTabs, closeTab, removeTabItem, writeOffTab, ensureWalkinSchema } from "./walkin.js";

function fail(err) {
  if (err instanceof WalkinError) return jsonResponse({ error: err.message, ...err.extra }, err.status);
  return jsonResponse({ error: "Something went wrong with the walk-in order.", message: err.message }, 500);
}

/** GET: the open tabs (with rounds and items). */
export async function walkinGetHandler(context) {
  try {
    await ensureWalkinSchema(context.env);
    return jsonResponse({ tabs: await listOpenTabs(context.env) });
  } catch (err) {
    return fail(err);
  }
}

/** POST { action: 'order' | 'close_tab' | 'remove_item' | 'write_off', ... } */
export async function walkinPostHandler(context) {
  const { request, env } = context;
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }
  try {
    switch (body.action) {
      case "order": {
        const result = await createWalkinOrder(env, body);
        queueDueNewOrderPushes(context); // best-effort notification to the other devices
        return jsonResponse({ success: true, ...result });
      }
      case "close_tab":
        return jsonResponse({ success: true, ...(await closeTab(env, { tabId: body.tab_id, cardReference: body.card_reference })) });
      case "remove_item":
        return jsonResponse({ success: true, ...(await removeTabItem(env, { orderId: body.order_id, itemId: body.item_id })) });
      case "write_off":
        return jsonResponse({ success: true, ...(await writeOffTab(env, { tabId: body.tab_id, reason: body.reason })) });
      default:
        return jsonResponse({ error: "Unknown action." }, 400);
    }
  } catch (err) {
    return fail(err);
  }
}
