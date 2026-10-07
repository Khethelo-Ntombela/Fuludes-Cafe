// Run with: node --test tests/
// Checks the saved-cart rules (functions/_lib/savedCart.js) without a database:
// the menu is faked. Covers merging, normalising, and rebuilding from the live menu.
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeCompact, mergeCompact, lineKey, hydrateCart, compactFromLines } from "../functions/_lib/savedCart.js";

const line = (itemId, quantity, extra = {}) => ({ itemId, quantity, spiceLevel: null, sideId: null, extraIds: [], ...extra });

const MENU = [
  { id: 1, name: "Burger", price: "100", special_price: null, is_available: true, stock_quantity: null, is_visible: true, accepts_spice: false, accepts_addons: false },
  { id: 2, name: "Pizza", price: "120", special_price: "90", special_starts_at: null, special_ends_at: null, is_available: true, stock_quantity: null, is_visible: true, accepts_spice: false, accepts_addons: false },
  { id: 3, name: "Old Special", price: "80", special_price: "60", special_ends_at: "2000-01-01T00:00:00Z", is_available: true, stock_quantity: null, is_visible: true, accepts_spice: false, accepts_addons: false },
  { id: 4, name: "Cake", price: "50", special_price: null, is_available: true, stock_quantity: 2, is_visible: true, accepts_spice: false, accepts_addons: false },
  { id: 5, name: "Switched Off", price: "40", special_price: null, is_available: false, stock_quantity: null, is_visible: true, accepts_spice: false, accepts_addons: false },
  { id: 6, name: "Hidden", price: "30", special_price: null, is_available: true, stock_quantity: null, is_visible: false, accepts_spice: false, accepts_addons: false },
  { id: 7, name: "Steak", price: "200", special_price: null, is_available: true, stock_quantity: null, is_visible: true, accepts_spice: false, accepts_addons: false },
  { id: 8, name: "Wings", price: "70", special_price: null, is_available: true, stock_quantity: null, is_visible: true, accepts_spice: true, accepts_addons: true },
];
const SIDES = [{ menu_item_id: 7, id: 1, name: "Chips" }];
const ADDONS = [{ menu_item_id: 8, id: 1, name: "Cheese", price: "15" }, { menu_item_id: 8, id: 2, name: "Egg", price: "10" }];

function fakeQuery(sql, params = []) {
  const ids = params[0] || [];
  if (sql.includes("FROM menu_items")) return { rows: MENU.filter((m) => ids.includes(m.id)) };
  if (sql.includes("menu_item_sides")) return { rows: SIDES.filter((s) => ids.includes(s.menu_item_id)) };
  if (sql.includes("menu_item_addons")) return { rows: ADDONS.filter((a) => ids.includes(a.menu_item_id)) };
  if (sql.includes("spice_levels")) return { rows: [{ name: "Mild" }, { name: "Hot" }] };
  throw new Error("unexpected query " + sql);
}
const hydrate = (items) => hydrateCart({}, items, async (_env, sql, params) => fakeQuery(sql, params));

test("merging adds identical lines and keeps both carts' other items", () => {
  const merged = mergeCompact([line(1, 1), line(2, 1)], [line(1, 2), line(4, 1)]);
  assert.deepEqual(merged.map((l) => [l.itemId, l.quantity]), [[1, 3], [2, 1], [4, 1]]);
});

test("normalising ignores junk, caps quantity and size", () => {
  const out = normalizeCompact([line(1, -1), line(1, "x"), null, 5, { itemId: "a", quantity: 1 }, line(1, 999)]);
  assert.deepEqual(out.map((l) => l.quantity), [50]);
  assert.ok(normalizeCompact(Array.from({ length: 200 }, (_, i) => line(1, 1, { extraIds: [i + 1] }))).length <= 60);
});

test("lineKey matches the key the menu page builds", () => {
  assert.equal(lineKey(line(8, 1, { spiceLevel: "Hot", extraIds: [2, 1] })), "8|Hot||1,2");
});

test("prices come from today's menu: special while running, normal once it ended", async () => {
  const { lines } = await hydrate([line(2, 1), line(3, 1)]);
  assert.deepEqual(lines.map((l) => [l.name, l.price]), [["Pizza", 90], ["Old Special", 80]]);
});

test("sold-out, switched-off and hidden dishes are removed with a message", async () => {
  const { lines, notices } = await hydrate([line(5, 1), line(6, 1), line(1, 1)]);
  assert.deepEqual(lines.map((l) => l.name), ["Burger"]);
  assert.equal(notices.length, 2);
});

test("quantity is lowered to the stock left", async () => {
  const { lines, notices } = await hydrate([line(4, 5)]);
  assert.equal(lines[0].quantity, 2);
  assert.match(notices[0], /Only 2/);
});

test("a dish with sides needs one of its sides; unknown extras are dropped", async () => {
  let r = await hydrate([line(7, 1), line(7, 1, { sideId: 1 })]);
  assert.deepEqual(r.lines.map((l) => l.side && l.side.name), ["Chips"]);
  r = await hydrate([line(8, 1, { spiceLevel: "Hot", extraIds: [2, 99] })]);
  assert.deepEqual(r.lines[0].extras, [{ id: 2, name: "Egg", price: 10 }]);
  assert.equal(r.lines[0].spiceLevel, "Hot");
});

test("round trip: full lines back to compact lines", async () => {
  const input = [line(8, 2, { spiceLevel: "Hot", extraIds: [1] }), line(1, 1)];
  const { lines } = await hydrate(input);
  assert.deepEqual(compactFromLines(lines), normalizeCompact(input));
});
