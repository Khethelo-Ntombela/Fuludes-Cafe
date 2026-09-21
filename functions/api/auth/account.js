import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireCustomer } from "../../_lib/customerAuth.js";
import { getRequestIp } from "../../_lib/security.js";

export async function onRequest(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;

  if (request.method === "PUT") {
    try {
      const body = await request.json();
      const emailOptIn = Boolean(body.marketing_email_opt_in);
      const smsOptIn = Boolean(body.marketing_sms_opt_in);
      await runQuery(
        env,
        "UPDATE customers SET marketing_email_opt_in = $1, marketing_sms_opt_in = $2 WHERE id = $3;",
        [emailOptIn, smsOptIn, customer.id],
      );
      return jsonResponse({
        success: true,
        marketing_email_opt_in: emailOptIn,
        marketing_sms_opt_in: smsOptIn,
      });
    } catch (err) {
      return jsonResponse(
        { error: "Failed to update account settings.", message: err.message },
        500,
      );
    }
  }
  if (request.method !== "DELETE")
    return jsonResponse(
      { error: "Method not allowed. Use PUT or DELETE." },
      405,
    );

  const requestIp = getRequestIp(request);

  try {
    // Delete customer row - cascades to customer_sessions and related rows
    const del = await runQuery(
      env,
      `DELETE FROM customers WHERE id = $1 RETURNING id, email, name;`,
      [customer.id],
    );
    if (!del.rows || del.rows.length === 0) {
      return jsonResponse({ error: "Account not found." }, 404);
    }

    // Account deletion by customer is not recorded in audit_logs (audit reserved for admin/staff actions)

    return jsonResponse({ success: true, message: "Account deleted." });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to delete account.", message: err.message },
      500,
    );
  }
}
