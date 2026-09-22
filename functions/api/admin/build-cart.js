/**
 * functions/api/admin/build-cart.js
 * -----------------------------------------------------------------------
 * POST /api/admin/build-cart  (Authorization: Bearer <admin token>)
 * Admin-only: build a cart/order on behalf of a customer and return a
 * time-limited secure payment link the customer can open to complete
 * payment. The resulting order follows the same rules as a normal order
 * (stock validation, server-side pricing).
 * Body: { customer_name, customer_email, customer_phone, cart_items: [...] }
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText } from "../../_lib/security.js";
import { buildYocoCheckout } from "../../_lib/yoco.js";
import { generateToken } from "../../_lib/password.js";
import { logAudit } from "../../_lib/audit.js";

export async function onRequestPost(context) {
  const { request, env } = context;
  const authError = await requireAdmin(request, env);
  if (authError) return authError;

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const customerName = sanitizeText(body.customer_name || "", 100);
  const customerEmail = sanitizeText(
    body.customer_email || "",
    200,
  ).toLowerCase();
  const customerPhone = sanitizeText(body.customer_phone || "", 50);
  const cartItems = Array.isArray(body.cart_items) ? body.cart_items : [];

  if (!customerName || !customerEmail || cartItems.length === 0) {
    return jsonResponse(
      { error: "Incomplete details: name, email and cart items are required." },
      400,
    );
  }

  try {
    // Look up an existing customer by email (optional)
    const custRes = await runQuery(
      env,
      "SELECT id FROM customers WHERE email = $1;",
      [customerEmail],
    );
    const customerId = custRes.rows[0] ? custRes.rows[0].id : null;

    // Re-price cart like normal order endpoint
    const itemIds = [
      ...new Set(
        cartItems.map((i) => parseInt(i.id, 10)).filter(Number.isInteger),
      ),
    ];
    const addonIds = [
      ...new Set(
        cartItems
          .flatMap((i) => (Array.isArray(i.extras) ? i.extras : []))
          .map((id) => parseInt(id, 10))
          .filter(Number.isInteger),
      ),
    ];

    if (itemIds.length === 0)
      return jsonResponse({ error: "Cart contains no valid items." }, 400);

    const menuResult = await runQuery(
      env,
      `
      SELECT id, name, price, special_price, is_available, stock_quantity, is_visible, accepts_spice, accepts_addons
      FROM menu_items WHERE id = ANY($1::int[]);
    `,
      [itemIds],
    );
    const menuById = Object.fromEntries(
      menuResult.rows.map((row) => [row.id, row]),
    );

    let addonsById = {};
    if (addonIds.length > 0) {
      const addonsResult = await runQuery(
        env,
        `
        SELECT id, name, price FROM addons WHERE id = ANY($1::int[]) AND is_active = TRUE;
      `,
        [addonIds],
      );
      addonsById = Object.fromEntries(
        addonsResult.rows.map((row) => [row.id, row]),
      );
    }

    const lineItems = [];
    const orderedQtyByItem = {};
    for (const cartItem of cartItems) {
      const menuItem = menuById[parseInt(cartItem.id, 10)];
      const quantity = parseInt(cartItem.quantity, 10);
      if (!menuItem || !menuItem.is_visible)
        return jsonResponse(
          { error: `Item ${cartItem.id} is no longer on the menu.` },
          400,
        );
      if (!menuItem.is_available)
        return jsonResponse(
          { error: `\"${menuItem.name}\" is sold out right now.` },
          400,
        );
      if (!Number.isInteger(quantity) || quantity < 1)
        return jsonResponse(
          { error: `Invalid quantity for \"${menuItem.name}\".` },
          400,
        );

      orderedQtyByItem[menuItem.id] =
        (orderedQtyByItem[menuItem.id] || 0) + quantity;
      if (
        menuItem.stock_quantity !== null &&
        orderedQtyByItem[menuItem.id] > menuItem.stock_quantity
      ) {
        return jsonResponse(
          {
            error: `Only ${menuItem.stock_quantity} of \"${menuItem.name}\" left in stock.`,
          },
          400,
        );
      }

      const spiceLevel =
        menuItem.accepts_spice && cartItem.spice_level
          ? String(cartItem.spice_level)
          : null;
      const extras = [];
      if (menuItem.accepts_addons && Array.isArray(cartItem.extras)) {
        for (const rawAddonId of cartItem.extras) {
          const addon = addonsById[parseInt(rawAddonId, 10)];
          if (addon)
            extras.push({ name: addon.name, price: parseFloat(addon.price) });
        }
      }

      const itemPrice =
        menuItem.special_price !== null
          ? parseFloat(menuItem.special_price)
          : parseFloat(menuItem.price);
      const extrasTotal = extras.reduce((sum, e) => sum + e.price, 0);
      const subtotal = (itemPrice + extrasTotal) * quantity;

      lineItems.push({
        menu_item_id: menuItem.id,
        item_name: menuItem.name,
        item_price: itemPrice,
        quantity,
        spice_level: spiceLevel,
        extras,
        subtotal,
      });
    }

    const totalAmount = lineItems.reduce((s, li) => s + li.subtotal, 0);

    // Create order row
    const orderInsert = await runQuery(
      env,
      `
      INSERT INTO orders (customer_id, customer_name, customer_phone, order_type, pickup_time, special_instructions, total_amount, status, payment_method, payment_status)
      VALUES ($1, $2, $3, 'collection', 'As soon as possible', NULL, $4, 'New', 'online', 'awaiting')
      RETURNING id, created_at;
    `,
      [customerId, customerName, customerPhone, totalAmount],
    );
    const newOrderId = orderInsert.rows[0].id;

    // Insert order_items
    for (const li of lineItems) {
      await runQuery(
        env,
        `
        INSERT INTO order_items (order_id, menu_item_id, item_name, item_price, quantity, spice_level, extras, subtotal)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8);
      `,
        [
          newOrderId,
          li.menu_item_id,
          li.item_name,
          li.item_price,
          li.quantity,
          li.spice_level,
          JSON.stringify(li.extras),
          li.subtotal,
        ],
      );
    }

    // Decrement stock
    for (const [menuItemId, qty] of Object.entries(orderedQtyByItem)) {
      await runQuery(
        env,
        `
        UPDATE menu_items
        SET stock_quantity = GREATEST(stock_quantity - $1, 0), is_available = (GREATEST(stock_quantity - $1, 0) > 0)
        WHERE id = $2 AND stock_quantity IS NOT NULL;
      `,
        [qty, parseInt(menuItemId, 10)],
      ).catch(() => {});
    }

    // Create a time-limited payment link (24h)
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await runQuery(
      env,
      `INSERT INTO payment_links (token, order_id, expires_at) VALUES ($1, $2, $3);`,
      [token, newOrderId, expiresAt],
    );

    await logAudit(env, {
      actor_type: "admin",
      actor_role: "admin",
      action: "admin_build_cart",
      target_type: "order",
      target_id: newOrderId,
      details: { customer_email: customerEmail, total_amount: totalAmount },
    });

    const origin = new URL(request.url).origin;
    const payUrl = `${origin}/paylink.html?token=${token}`;

    return jsonResponse({
      success: true,
      order_id: newOrderId,
      total_amount: totalAmount,
      pay_url: payUrl,
      token,
    });
  } catch (err) {
    return jsonResponse(
      {
        error: "Failed to build cart on behalf of customer.",
        message: err.message,
      },
      500,
    );
  }
}
