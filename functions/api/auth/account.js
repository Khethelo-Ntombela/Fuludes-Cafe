/**
 * functions/api/auth/account.js
 * -----------------------------------------------------------------------
 * PUT    /api/auth/account  - update account details. Send any of:
 *          { name }                     -> username / display name
 *          { phone_number }, { delivery_address }
 *          { marketing_email_opt_in }   -> email marketing on/off
 *        Only the fields that are present are changed. Passwords are NOT
 *        changed here - see change-password.js (needs email confirmation).
 * DELETE /api/auth/account  - permanently delete the signed-in account.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireCustomer } from "../../_lib/customerAuth.js";
import { sanitizeText, isValidEmail, isValidName, normalizePhone, VALIDATION_MESSAGES } from "../../_lib/security.js";

export async function onRequest(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;

  if (request.method === "PUT") {
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ error: "Invalid JSON body." }, 400);
    }

    const sets = [];
    const params = [];
    const push = (column, value) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };

    if (body.name !== undefined) {
      const name = sanitizeText(body.name, 100);
      if (!name) return jsonResponse({ error: "Username can't be empty." }, 400);
      if (!isValidName(name)) return jsonResponse({ error: VALIDATION_MESSAGES.name }, 400);
      push("name", name);
    }
    if (body.phone_number !== undefined) {
      const phoneInput = sanitizeText(body.phone_number, 30);
      const phone = phoneInput ? normalizePhone(phoneInput) : null; // empty clears it
      if (phoneInput && !phone) return jsonResponse({ error: VALIDATION_MESSAGES.phone }, 400);
      push("phone_number", phone);
    }
    if (body.delivery_address !== undefined) {
      push("delivery_address", sanitizeText(body.delivery_address, 500) || null);
    }
    if (body.marketing_email_opt_in !== undefined) {
      push("marketing_email_opt_in", Boolean(body.marketing_email_opt_in));
    }

    if (sets.length === 0) {
      return jsonResponse({ error: "Nothing to update." }, 400);
    }

    try {
      params.push(customer.id);
      const result = await runQuery(
        env,
        `UPDATE customers SET ${sets.join(", ")} WHERE id = $${params.length}
         RETURNING id, name, email, phone_number, delivery_address, marketing_email_opt_in;`,
        params,
      );
      return jsonResponse({
        success: true,
        message: "Your changes have been saved.",
        customer: { ...customer, ...result.rows[0] },
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

  try {
    // Delete customer row - cascades to customer_sessions, password resets,
    // pending password changes and related rows.
    const del = await runQuery(
      env,
      `DELETE FROM customers WHERE id = $1 RETURNING id;`,
      [customer.id],
    );
    if (!del.rows || del.rows.length === 0) {
      return jsonResponse({ error: "Account not found." }, 404);
    }
    return jsonResponse({ success: true, message: "Account deleted." });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to delete account.", message: err.message },
      500,
    );
  }
}
