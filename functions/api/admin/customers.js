import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdminPermission } from "../../_lib/adminAuth.js";
import { logAudit } from "../../_lib/audit.js";
import { getRequestIp } from "../../_lib/security.js";

export async function onRequestGet(context) {
  const { request, env } = context;
  const auth = await requireAdminPermission(request, env, "customers");
  if (auth.error) return auth.error;
  try {
    const url = new URL(request.url);
    const search = (url.searchParams.get("search") || "").trim();
    const result = await runQuery(
      env,
      `
      SELECT id, name, email, phone_number, delivery_address, is_verified,
             marketing_email_opt_in, created_at
      FROM customers
      WHERE ($1 = '' OR name ILIKE $2 OR email ILIKE $2 OR phone_number ILIKE $2)
      ORDER BY created_at DESC LIMIT 200;
    `,
      [search, `%${search}%`],
    );
    return jsonResponse({ customers: result.rows });
  } catch (error) {
    return jsonResponse(
      { error: "Failed to load customer records.", message: error.message },
      500,
    );
  }
}

// DELETE /api/admin/customers?id=123 - removes a customer account and signs it out everywhere.
// Deleting the row cascades to customer_sessions (so every signed-in device loses access on its
// next request), saved cart, password resets and push subscriptions. Orders, reviews and
// reservations stay for the cafe's records with the customer link cleared (ON DELETE SET NULL).
export async function onRequestDelete(context) {
  const { request, env } = context;
  const auth = await requireAdminPermission(request, env, "customers");
  if (auth.error) return auth.error;
  const id = parseInt(new URL(request.url).searchParams.get("id"), 10);
  if (!Number.isInteger(id)) return jsonResponse({ error: "Customer id is required." }, 400);
  try {
    const removed = await runQuery(
      env,
      "DELETE FROM customers WHERE id = $1 RETURNING id, name, email;",
      [id],
    );
    if (!removed.rows.length) return jsonResponse({ error: "Customer not found." }, 404);
    const customer = removed.rows[0];
    await logAudit(env, {
      actor_type: "admin",
      actor_role: "admin",
      actor_ip: getRequestIp(request),
      action: "customer_account_deleted",
      target_type: "customer",
      target_id: id,
      details: { name: customer.name, email: customer.email },
    }).catch(() => {}); // the account is gone either way - don't report a failure over the log
    return jsonResponse({ success: true });
  } catch (error) {
    return jsonResponse(
      { error: "Failed to delete the customer account.", message: error.message },
      500,
    );
  }
}
