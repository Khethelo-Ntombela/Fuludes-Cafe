// When a table-booking pre-order reaches the admin / kitchen boards
/** Minutes before the booking time that a table pre-order appears on the admin and kitchen boards. */
export const PREORDER_SHOW_MINUTES = 20;

// SQL: when a booking's pre-order is due on the boards (South African time), NULL for ordinary orders.
const RES_SHOW_AT = `(SELECT ((r.reservation_date + r.reservation_time) AT TIME ZONE 'Africa/Johannesburg') - INTERVAL '${PREORDER_SHOW_MINUTES} minutes'
                         FROM customer_reservations r WHERE r.advance_order_id = orders.id LIMIT 1)`;

/** SQL: the moment a paid order reaches the boards = after its 2-minute window, and for a booking's pre-order not before 20 min ahead. */
export const ORDER_SHOW_AT = `GREATEST(kitchen_release_at, COALESCE(${RES_SHOW_AT}, kitchen_release_at))`;

/** SQL condition: true when the order may be shown on the boards right now. */
export const ORDER_VISIBLE_NOW = `(kitchen_release_at IS NULL OR ${ORDER_SHOW_AT} <= NOW())`;
