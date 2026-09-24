import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdminPermission } from "../../_lib/adminAuth.js";

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
