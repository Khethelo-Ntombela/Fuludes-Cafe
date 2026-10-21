// POST /api/admin/build-cart
import { runQuery, jsonResponse } from "../../_lib/db.js";
import { requireAdmin } from "../../_lib/auth.js";
import { sanitizeText, isValidEmail, isValidName, normalizePhone, VALIDATION_MESSAGES } from "../../_lib/security.js";
import { generateToken } from "../../_lib/password.js";
import { logAudit } from "../../_lib/audit.js";
import { calculateDeliveryFee } from "../../_lib/delivery.js";
import { createYocoCheckout } from "../../_lib/yoco.js";
import { getBusinessHours, isOpenNow, validateReservationSlot, validatePickupSlot, OUTSIDE_HOURS_LINK_MESSAGE } from "../../_lib/hours.js";
import { ensureScheduleColumns, scheduledForFromPickup } from "../../_lib/scheduledOrders.js";

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
  const customerPhoneInput = sanitizeText(body.customer_phone || "", 50);
  const customerPhone = normalizePhone(customerPhoneInput) || "";
  const cartItems = Array.isArray(body.cart_items) ? body.cart_items : [];
  const orderType = ["delivery", "dine_in"].includes(body.order_type) ? body.order_type : "collection";
  const deliveryAddress = sanitizeText(body.delivery_address || "", 500);
  const tableNumber = sanitizeText(body.table_number || "", 30);
  let pickupTime = sanitizeText(body.pickup_time || "As soon as possible", 60);
  // Dine in works like the customer's table booking: a date, a time and (for a later day) the party size.
  const todaySA = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Johannesburg" }).format(new Date());
  const dineDate = orderType === "dine_in" ? sanitizeText(body.dine_date || todaySA, 10) : todaySA;
  const dineTime = sanitizeText(body.dine_time || "", 5); // "HH:MM" for a later day
  const partySize = parseInt(body.party_size, 10);
  const isReservation = orderType === "dine_in" && dineDate !== todaySA;
  const specialInstructions = sanitizeText(body.special_instructions || "", 500);

  if (customerName && !isValidName(customerName)) return jsonResponse({ error: VALIDATION_MESSAGES.name }, 400);
  if (customerPhoneInput && !customerPhone) return jsonResponse({ error: VALIDATION_MESSAGES.phone }, 400);
  if (customerEmail && !isValidEmail(customerEmail)) return jsonResponse({ error: VALIDATION_MESSAGES.email }, 400);
  if (!customerName || !customerPhone || cartItems.length === 0) {
    return jsonResponse(
      { error: "Incomplete details: customer name, phone and cart items are required." },
      400,
    );
  }

  // Outside working hours (the hours saved in Settings > General): no payment link for a collection,
  // delivery or dine-in-today order. A table booking for a later date is allowed - its time is checked
  // against the opening hours of that day below.
  const hours = await getBusinessHours(env);
  if (!isReservation && !isOpenNow(hours)) {
    return jsonResponse({ error: OUTSIDE_HOURS_LINK_MESSAGE, outside_hours: true }, 409);
  }

  try {
    // Look up an existing customer by email (optional)
    const custRes = customerEmail
      ? await runQuery(env, "SELECT id FROM customers WHERE email = $1;", [customerEmail])
      : { rows: [] };
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

    const sideLinkResult = await runQuery(
      env,
      `SELECT mis.menu_item_id, s.id, s.name
         FROM menu_item_sides mis JOIN sides s ON s.id = mis.side_id
        WHERE s.is_active = TRUE AND mis.menu_item_id = ANY($1::int[]);`,
      [itemIds],
    ).catch(() => ({ rows: [] }));
    const sidesByItem = {};
    for (const row of sideLinkResult.rows) {
      (sidesByItem[row.menu_item_id] || (sidesByItem[row.menu_item_id] = [])).push(row);
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

      // Free side (required when the dish offers sides) - stored as a R0 extra.
      const offeredSides = sidesByItem[menuItem.id] || [];
      if (offeredSides.length > 0) {
        const chosen = offeredSides.find((sd) => sd.id === parseInt(cartItem.side, 10));
        if (!chosen)
          return jsonResponse({ error: `Please choose a side for "${menuItem.name}".` }, 400);
        extras.unshift({ name: `Side: ${chosen.name}`, price: 0 });
      }

      // Special price only counts while its schedule is active.
      const now = new Date();
      const starts = menuItem.special_starts_at ? new Date(menuItem.special_starts_at) : null;
      const ends = menuItem.special_ends_at ? new Date(menuItem.special_ends_at) : null;
      const specialActive =
        menuItem.special_price !== null && (!starts || now >= starts) && (!ends || now < ends);
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

    // Delivery: price it from the coordinates the admin's address lookup found.
    let deliveryFee = 0;
    let deliveryDistanceKm = 0;
    let deliveryLat = null;
    let deliveryLng = null;
    if (orderType === "delivery") {
      const hasCoords =
        body.delivery_lat != null && body.delivery_lng != null &&
        body.delivery_lat !== "" && body.delivery_lng !== "";
      const lat = hasCoords ? Number(body.delivery_lat) : NaN;
      const lng = hasCoords ? Number(body.delivery_lng) : NaN;
      const located = Number.isFinite(lat) && Number.isFinite(lng);
      // Admin can set the fee by hand (e.g. an address beyond the fee bands, or
      // one the geocoder can't find) - it's then used instead of the band price.
      const override = body.delivery_fee_override;
      const manualFee =
        override !== undefined && override !== null && override !== "" && Number.isFinite(Number(override)) && Number(override) >= 0
          ? Math.round(Number(override) * 100) / 100
          : null;
      if (!deliveryAddress || (!located && manualFee === null)) {
        return jsonResponse(
          { error: "Enter the delivery address and let it be located (tap outside the box), or set the delivery fee manually." },
          400,
        );
      }
      if (located) {
        const feeCalc = await calculateDeliveryFee(env, lat, lng);
        if (feeCalc.too_far && manualFee === null) {
          return jsonResponse(
            { error: `That address is a bit far (about ${feeCalc.distance_km} km). Set the delivery fee manually to continue.`, too_far: true },
            400,
          );
        }
        deliveryFee = feeCalc.fee;
        deliveryDistanceKm = feeCalc.distance_km;
        deliveryLat = lat;
        deliveryLng = lng;
      }
      if (manualFee !== null) deliveryFee = manualFee;
    }
    if (orderType === "dine_in" && !isReservation && !tableNumber) {
      return jsonResponse({ error: "Enter the table number for a dine-in order." }, 400);
    }

    // Dine in on a later date = a table reservation with a pre-order; today = a timed/ASAP order.
    let scheduledFor = null;
    if (orderType === "dine_in" && isReservation) {
      const slotError = validateReservationSlot(dineDate, dineTime, hours);
      if (slotError) return jsonResponse({ error: slotError }, 400);
      if (!Number.isInteger(partySize) || partySize < 1 || partySize > 200) {
        return jsonResponse({ error: "Enter how many people the booking is for." }, 400);
      }
      // South Africa has no daylight saving: always UTC+2
      scheduledFor = new Date(`${dineDate}T${dineTime}:00+02:00`);
      pickupTime = `Reservation ${dineDate} at ${dineTime}`;
    } else {
      // Collection/delivery: "As soon as possible" or a half-hour slot today (same check as the customer's Preferred Time).
      const slotError = validatePickupSlot(pickupTime, hours);
      if (slotError) return jsonResponse({ error: slotError }, 400);
      // Dine in has no "as soon as possible": a time must be chosen.
      if (orderType === "dine_in" && !/^at \d{1,2}:\d{2}(\s*-\s*\d{1,2}:\d{2})?$/i.test(pickupTime.trim())) {
        return jsonResponse({ error: "Choose the time for the dine-in order." }, 400);
      }
      scheduledFor = scheduledForFromPickup(pickupTime);
    }
    await ensureScheduleColumns(env);

    const itemsTotal = lineItems.reduce((s, li) => s + li.subtotal, 0);
    const totalAmount = itemsTotal + deliveryFee;

    // Create order row
    const orderInsert = await runQuery(
      env,
      `
      INSERT INTO orders
        (customer_id, customer_name, customer_phone, order_type, delivery_address, delivery_lat, delivery_lng,
         delivery_distance_km, delivery_fee, table_number, pickup_time, special_instructions,
         total_amount, status, payment_method, payment_status, stock_decremented, scheduled_for)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'New', 'online', 'awaiting', FALSE, $14)
      RETURNING id, created_at;
    `,
      [
        customerId, customerName, customerPhone, orderType,
        orderType === "delivery" ? deliveryAddress : null,
        deliveryLat, deliveryLng, deliveryDistanceKm, deliveryFee,
        orderType === "dine_in" ? tableNumber : null,
        pickupTime, specialInstructions || null, totalAmount,
        scheduledFor ? scheduledFor.toISOString() : null,
      ],
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

    // Later-date dine in: save the booking and tie this order to it as its pre-order.
    // It stays "AwaitingPayment" (hidden) until paid, then payment confirms it - same as a customer's.
    if (isReservation) {
      try {
        await runQuery(
          env,
          `INSERT INTO customer_reservations (
             customer_id, customer_name, customer_email, customer_phone,
             reservation_date, reservation_time, party_size, table_number, notes,
             advance_order_requested, advance_order_id, status
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, $10, 'AwaitingPayment');`,
          [customerId, customerName, customerEmail, customerPhone, dineDate, dineTime, partySize,
            tableNumber || null, specialInstructions || null, newOrderId],
        );
      } catch (resErr) {
        await runQuery(env, "DELETE FROM orders WHERE id = $1;", [newOrderId]).catch(() => {});
        return jsonResponse({ error: `Couldn't save the reservation: ${resErr.message}` }, 500);
      }
    }

    // Stock is deliberately NOT decremented here: payment/notify.js does it once the
    // payment is confirmed (decrementing now would take stock twice and hold it for unpaid links).

    // Create this order's Yoco checkout now, so a problem (no YOCO_SECRET_KEY,
    // Yoco rejecting it) shows up for the admin instead of in a broken link.
    const origin = new URL(request.url).origin;
    let checkoutUrl;
    try {
      if (!env.YOCO_SECRET_KEY) {
        throw new Error("YOCO_SECRET_KEY is not set in Cloudflare (Settings > Environment variables), so Yoco checkouts can't be created.");
      }
      const checkout = await createYocoCheckout(env, {
        orderId: newOrderId,
        amount: totalAmount,
        returnUrl: `${origin}/home.html?payment=success&order_id=${newOrderId}`,
        cancelUrl: `${origin}/home.html?payment=cancelled&order_id=${newOrderId}`,
      });
      checkoutUrl = checkout.redirect_url;
    } catch (yocoErr) {
      // No usable link - don't leave an orphan unpaid order behind (items cascade).
      await runQuery(env, "DELETE FROM customer_reservations WHERE advance_order_id = $1 AND status = 'AwaitingPayment';", [newOrderId]).catch(() => {});
      await runQuery(env, "DELETE FROM orders WHERE id = $1 AND payment_status = 'awaiting';", [newOrderId]).catch(() => {});
      return jsonResponse({ error: `Couldn't create the Yoco payment: ${yocoErr.message}` }, 502);
    }

    // Time-limited link (24h) that opens this order's Yoco checkout.
    const token = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await runQuery(env, "ALTER TABLE payment_links ADD COLUMN IF NOT EXISTS checkout_url TEXT;");
    await runQuery(
      env,
      `INSERT INTO payment_links (token, order_id, expires_at, checkout_url) VALUES ($1, $2, $3, $4);`,
      [token, newOrderId, expiresAt, checkoutUrl],
    );

    await logAudit(env, {
      actor_type: "admin",
      actor_role: "admin",
      action: "admin_build_cart",
      target_type: "order",
      target_id: newOrderId,
      details: { customer_email: customerEmail, total_amount: totalAmount, order_type: orderType, delivery_fee: deliveryFee, reservation: isReservation ? { date: dineDate, time: dineTime, party_size: partySize } : undefined },
    });

    // Opens straight onto the Yoco payment page (functions/api/paylink.js).
    const payUrl = `${origin}/api/paylink?token=${token}`;

    return jsonResponse({
      success: true,
      order_id: newOrderId,
      total_amount: totalAmount,
      items_total: itemsTotal,
      delivery_fee: deliveryFee,
      pay_url: payUrl,
      token,
      is_reservation: isReservation,
      reservation_when: isReservation ? `${dineDate} at ${dineTime}` : null,
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
