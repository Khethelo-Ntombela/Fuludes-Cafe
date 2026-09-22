/**
 * functions/api/order.js
 * -----------------------------------------------------------------------
 * POST /api/order  (Authorization: Bearer <customer session token>)
 * Places a checkout order. An account is required to check out - see
 * functions/_lib/customerAuth.js - so every order is tied to a
 * `customer_id`. Expects JSON:
 * {
 *   customer_name, phone_number, order_type ("collection"|"delivery"|"dine_in"),
 *   delivery_address, table_number, pickup_time, special_instructions,
 *   cart_items: [{ id, quantity, spice_level, extras: [addonId, ...] }]
 * }
 *
 * Payment is strictly online through Yoco - every order must be paid before
 * the kitchen sees it as placed. There is no pay-at-pickup/delivery path.
 *
 * Security note: prices are NEVER trusted from the browser. Every item id
 * and every addon id in the cart is re-priced against the current Neon
 * `menu_items` / `addons` tables, so a tampered client payload cannot
 * change what gets billed - including the amount that gets sent to Yoco.
 *
 * Specials: menu_items.special_price is nullable - when set on an item, it
 * IS that item's price here, full stop, regardless of what the browser
 * sent. `price` is only ever used as the "was" price for display.
 *
 * Stock: menu_items.stock_quantity is nullable - NULL means untracked and
 * always available. Quantities are checked before order creation, then
 * decremented only after a signed payment confirmation.
 *
 * The order is created immediately with payment_status = 'awaiting' (the
 * kitchen doesn't treat it as confirmed yet) and the response includes a
 * `payment` object for the browser to hand off to Yoco to complete payment.
 * functions/api/payment/notify.js updates payment_status to 'paid' after
 * the gateway confirms the transaction.
 *
 * Full order history now lives on the account - see
 * functions/api/order/my.js for the "My Orders" listing, which replaced
 * the old guest phone+localStorage lookup entirely.
 *
 * PUT /api/order  { id }  (Authorization: Bearer <customer session token>)
 * Customer self-service cancel - only for an order that belongs to the
 * signed-in customer, only while it's still "New" (nobody's started
 * preparing it yet), and only during the short hold before the order is
 * released to the kitchen. Paid orders use kitchen_release_at, which is
 * set by the payment webhook to two minutes after payment confirmation.
 * -----------------------------------------------------------------------
 */
import { runQuery, jsonResponse } from "../_lib/db.js";
import { buildYocoCheckout } from "../_lib/yoco.js";
import {
  requireCustomer,
  ensureCustomerProfileColumns,
} from "../_lib/customerAuth.js";
import { sanitizeText, getRequestIp } from "../_lib/security.js";
import { logAudit } from "../_lib/audit.js";

const CUSTOMER_CANCEL_WINDOW_MS = 2 * 60 * 1000; // keep in sync with CUSTOMER_CANCEL_WINDOW_MS in public/js/main.js
const ROAD_BUFFER = 1.3; // straight-line * 1.3 ≈ road distance

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

async function calculateDeliveryFee(env, deliveryLat, deliveryLng) {
  const configRes = await runQuery(
    env,
    `SELECT cafe_latitude, cafe_longitude FROM app_config WHERE id = 1;`
  );
  const config = configRes.rows[0];
  if (!config || config.cafe_latitude == null || config.cafe_longitude == null) {
    return { fee: 0, distance_km: 0, too_far: false };
  }

  const cafeLat = parseFloat(config.cafe_latitude);
  const cafeLng = parseFloat(config.cafe_longitude);

  const straightKm = haversineKm(cafeLat, cafeLng, deliveryLat, deliveryLng);
  const roadKm = straightKm * ROAD_BUFFER;

  const bandsRes = await runQuery(
    env,
    `SELECT up_to_km, fee FROM delivery_fee_bands ORDER BY sort_order;`
  );
  const bands = bandsRes.rows || [];
  const matchedBand = bands.find((b) => roadKm <= b.up_to_km);

  if (!matchedBand) {
    return { fee: 0, distance_km: Math.round(roadKm * 100) / 100, too_far: true };
  }

  return {
    fee: parseFloat(matchedBand.fee),
    distance_km: Math.round(roadKm * 100) / 100,
    band_up_to_km: matchedBand.up_to_km,
    too_far: false,
  };
}

export async function onRequestPut(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  const requestIp = getRequestIp(request);

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const orderId = parseInt(body.id, 10);
  if (!Number.isInteger(orderId)) {
    return jsonResponse({ error: "A valid order id is required." }, 400);
  }

  try {
    const orderResult = await runQuery(
      env,
      "SELECT id, status, created_at, customer_id, payment_status, kitchen_release_at FROM orders WHERE id = $1;",
      [orderId],
    );
    const order = orderResult.rows[0];

    if (!order || order.customer_id !== customer.id) {
      return jsonResponse({ error: "Order not found." }, 404);
    }
    if (order.status !== "New") {
      return jsonResponse(
        {
          error:
            "This order can no longer be cancelled - it's already being prepared.",
        },
        400,
      );
    }

    const releaseAtMs = order.kitchen_release_at
      ? new Date(order.kitchen_release_at).getTime()
      : new Date(order.created_at).getTime() + CUSTOMER_CANCEL_WINDOW_MS;
    if (Date.now() > releaseAtMs) {
      return jsonResponse(
        {
          error:
            "The cancellation window for this order has passed. Please contact the cafe directly.",
        },
        400,
      );
    }

    // Re-check status='New' in the WHERE clause too, in case staff acted
    // on it in the moment between the SELECT above and this UPDATE.
    const cancelQuery =
      order.payment_status === "paid"
        ? `UPDATE orders SET status = 'Cancelled', refund_needed = TRUE WHERE id = $1 AND customer_id = $2 AND status = 'New' RETURNING id;`
        : `UPDATE orders SET status = 'Cancelled' WHERE id = $1 AND customer_id = $2 AND status = 'New' RETURNING id;`;
    const cancelResult = await runQuery(env, cancelQuery, [
      orderId,
      customer.id,
    ]);

    if (cancelResult.rows.length === 0) {
      return jsonResponse(
        {
          error:
            "This order can no longer be cancelled - it's already being prepared.",
        },
        400,
      );
    }

    // Customer-initiated order cancellation is not written to audit_logs (audit reserved for admin/staff actions)

    return jsonResponse({ success: true });
  } catch (err) {
    return jsonResponse(
      { error: "Failed to cancel order.", message: err.message },
      500,
    );
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const { customer, error } = await requireCustomer(request, env);
  if (error) return error;
  await ensureCustomerProfileColumns(env);

  // Block checkout when Out-of-Service mode is active
  try {
    const cfgRes = await runQuery(
      env,
      "SELECT is_out_of_service, out_of_service_reason FROM app_config WHERE id = 1;",
    );
    const cfg = cfgRes.rows[0];
    if (cfg && cfg.is_out_of_service) {
      const reason =
        cfg.out_of_service_reason || "Checkout is temporarily unavailable.";
      return jsonResponse({ error: reason }, 503);
    }
  } catch (cfgErr) {
    // don't fail hard on config read problems; let normal validation continue
  }

  let orderData;
  try {
    orderData = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body." }, 400);
  }

  const customerName = sanitizeText(orderData.customer_name || "", 100);
  const phoneNumber = sanitizeText(orderData.phone_number || "", 50);
  const orderType = ["delivery", "dine_in"].includes(orderData.order_type)
    ? orderData.order_type
    : "collection";
  const deliveryAddress = sanitizeText(orderData.delivery_address || "", 200);
  const tableNumber = sanitizeText(orderData.table_number || "", 30);
  const pickupTime = sanitizeText(
    orderData.pickup_time || "As soon as possible",
    100,
  );
  const specialInstructions = sanitizeText(
    orderData.special_instructions || "",
    500,
  );
  const paymentMethod = "online"; // payment is strictly online - no pay-at-pickup/delivery path
  const cartItems = Array.isArray(orderData.cart_items)
    ? orderData.cart_items
    : [];

  // ---- Strict validation ----
  if (!customerName || !phoneNumber || cartItems.length === 0) {
    return jsonResponse(
      { error: "Incomplete order details or empty cart." },
      400,
    );
  }
  if (orderType === "delivery" && !deliveryAddress) {
    return jsonResponse(
      { error: "Delivery address is required for delivery orders." },
      400,
    );
  }
  if (!env.YOCO_PAYMENT_URL && !env.YOCO_CHECKOUT_URL) {
    // Fail before touching the database - never create an order we can't
    // actually collect payment for. Online payment is the only path now,
    // so a misconfigured server means nobody can check out at all.
    return jsonResponse(
      {
        error:
          "Online payment isn't set up yet. Please contact the cafe directly to place your order.",
      },
      500,
    );
  }

  try {
    // ---- Re-price every cart line against the live database ----
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

    if (itemIds.length === 0) {
      return jsonResponse({ error: "Cart contains no valid items." }, 400);
    }

    const menuResult = await runQuery(
      env,
      `
      SELECT id, name, price, special_price, special_starts_at, special_ends_at, is_available, stock_quantity, is_visible, accepts_spice, accepts_addons
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

    // Build validated, server-priced line items
    const lineItems = [];
    const orderedQtyByItem = {}; // tracks total quantity per menu_item_id across all cart lines, for the stock check below
    for (const cartItem of cartItems) {
      const menuItem = menuById[parseInt(cartItem.id, 10)];
      const quantity = parseInt(cartItem.quantity, 10);

      if (!menuItem || !menuItem.is_visible) {
        return jsonResponse(
          { error: `Item ${cartItem.id} is no longer on the menu.` },
          400,
        );
      }
      if (!menuItem.is_available) {
        return jsonResponse(
          { error: `"${menuItem.name}" is sold out right now.` },
          400,
        );
      }
      if (!Number.isInteger(quantity) || quantity < 1) {
        return jsonResponse(
          { error: `Invalid quantity for "${menuItem.name}".` },
          400,
        );
      }

      // Stock check - null stock_quantity means untracked/unlimited, so only
      // items the admin is actively tracking get capped here. Aggregate
      // across cart lines in case the same dish appears more than once
      // (e.g. different spice levels) in a single order.
      orderedQtyByItem[menuItem.id] =
        (orderedQtyByItem[menuItem.id] || 0) + quantity;
      if (
        menuItem.stock_quantity !== null &&
        orderedQtyByItem[menuItem.id] > menuItem.stock_quantity
      ) {
        return jsonResponse(
          {
            error: `Only ${menuItem.stock_quantity} of "${menuItem.name}" left in stock.`,
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

      // Special price applies only when currently scheduled as active.
      const now = new Date();
      const starts = menuItem.special_starts_at
        ? new Date(menuItem.special_starts_at)
        : null;
      const ends = menuItem.special_ends_at
        ? new Date(menuItem.special_ends_at)
        : null;
      const specialActive =
        menuItem.special_price !== null &&
        (!starts || now >= starts) &&
        (!ends || now < ends);
      const itemPrice = specialActive
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

    // ---- Calculate delivery fee server-side if delivery order ----
    let deliveryFee = 0;
    let deliveryDistanceKm = 0;
    let deliveryLat = null;
    let deliveryLng = null;
    let tooFar = false;

    if (orderType === "delivery") {
      // The client should have sent geocoded coordinates; if not, we can't calculate
      // but we still allow the order through with 0 fee (client will show warning)
      const clientLat = Number(orderData.delivery_lat);
      const clientLng = Number(orderData.delivery_lng);
      if (Number.isFinite(clientLat) && Number.isFinite(clientLng)) {
        const feeCalc = await calculateDeliveryFee(env, clientLat, clientLng);
        deliveryFee = feeCalc.fee;
        deliveryDistanceKm = feeCalc.distance_km;
        deliveryLat = clientLat;
        deliveryLng = clientLng;
        tooFar = feeCalc.too_far;
        if (tooFar) {
          return jsonResponse(
            {
              error: "Delivery address is too far. Please contact us first.",
              too_far: true,
              distance_km: deliveryDistanceKm,
              cafe_phone: (await runQuery(env, "SELECT cafe_phone FROM app_config WHERE id = 1;")).rows[0]?.cafe_phone,
              cafe_email: (await runQuery(env, "SELECT cafe_email FROM app_config WHERE id = 1;")).rows[0]?.cafe_email,
            },
            400
          );
        }
      }
    }

    const totalAmount = lineItems.reduce((sum, li) => sum + li.subtotal, 0) + deliveryFee;

    // ---- Create the order ----
    await runQuery(
      env,
      `
      UPDATE customers
      SET name = $1,
          phone_number = COALESCE(NULLIF($2, ''), phone_number),
          delivery_address = COALESCE(NULLIF($3, ''), delivery_address)
      WHERE id = $4;
    `,
      [customerName, phoneNumber, deliveryAddress, customer.id],
    );

    const initialPaymentStatus = "awaiting"; // every order is online-paid; kitchen won't treat it as confirmed until the payment gateway callback fires
    const orderInsert = await runQuery(
      env,
      `
      INSERT INTO orders
        (customer_id, customer_name, customer_phone, order_type, delivery_address, delivery_lat, delivery_lng, delivery_distance_km, delivery_fee, table_number, pickup_time, special_instructions, total_amount, status, payment_method, payment_status, stock_decremented)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'New', $14, $15, FALSE)
      RETURNING id, created_at;
    `,
      [
        customer.id,
        customerName,
        phoneNumber,
        orderType,
        deliveryAddress || null,
        deliveryLat,
        deliveryLng,
        deliveryDistanceKm,
        deliveryFee,
        tableNumber || null,
        pickupTime,
        specialInstructions || null,
        totalAmount,
        paymentMethod,
        initialPaymentStatus,
      ],
    );

    const newOrderId = orderInsert.rows[0].id;
    // Customer order creation not written to audit_logs (audit reserved for admin/staff actions)

    // ---- Insert each line item, tied to the new order ----
    try {
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
    } catch (itemError) {
      // Best-effort rollback: remove the orphaned order (order_items cascade)
      await runQuery(env, "DELETE FROM orders WHERE id = $1;", [
        newOrderId,
      ]).catch(() => {});
      throw itemError;
    }

    // ---- Hand back the Yoco checkout redirect payload ----
    const origin = new URL(request.url).origin;
    const payment = buildYocoCheckout(env, {
      orderId: newOrderId,
      amount: totalAmount,
      itemName: `Fulude's Cafe Order #${newOrderId}`,
      customerName,
      customerEmail: customer.email,
      customerPhone: phoneNumber,
      returnUrl: `${origin}/?payment=success&order_id=${newOrderId}`,
      cancelUrl: `${origin}/?payment=cancelled&order_id=${newOrderId}`,
      notifyUrl: `${origin}/api/payment/notify`,
    });

    return jsonResponse({
      success: true,
      message: "Order placed successfully at Fulude's Cafe!",
      order_id: newOrderId,
      total_billed: totalAmount,
      payment_method: paymentMethod,
      delivery_fee: deliveryFee,
      delivery_distance_km: deliveryDistanceKm,
      payment,
    });
  } catch (err) {
    return jsonResponse(
      { error: "Server failed to process order ticket.", message: err.message },
      500,
    );
  }
}
