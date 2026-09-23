# Fulude's Cafe — Web App

A framework-free (vanilla HTML/CSS/JS) ordering site + admin dashboard for Fulude's Cafe, built entirely on free tiers:

- **Frontend:** Cloudflare Pages (static `public/`)
- **Backend:** Cloudflare Pages Functions (`functions/`, vanilla JS, no Express)
- **Database:** Neon Postgres, queried through Neon's serverless PostgreSQL driver
- **Images:** Cloudflare R2 object storage
- **Cost:** R0/month on Cloudflare's Free plan + Neon's Free plan, for a single-location cafe's traffic

---

## 1. File tree

```
public/
  index.html          platform landing / role portal (Customer, Admin, Kitchen tiles;
                       becomes the RBAC gate once login is wired)
  home.html            customer home page (hero, about, menu/catering/reviews gateways)
  menu.html            menu & online ordering (search, categories, cart, checkout)
  catering.html         catering services (cards, inspiration gallery, inquiry form)
  reviews.html           review wall + leave-a-review form
  contact.html            Visit Us (address/map), FAQ, and Privacy & Refund policies
  admin.html           admin dashboard (password-gated, owner only)
  staff.html            kitchen Staff Portal (separate password, own login)
  css/style.css         customer site styles (black/gold/cream, Playfair Display + Inter)
  css/admin.css         admin dashboard styles (extends style.css)
  css/staff.css           staff Kanban board layout (extends style.css + admin.css)
  js/site.js            shared customer logic loaded on every page: header/nav, accounts
                         (sign up/in/out, password reset), reservation modal, My Orders
                         tracker, photo lightbox, payment-return banner, FAQ accordions
  js/menu.js             menu page logic: menu fetch, search, specials, cart (persisted in
                          localStorage across pages), checkout + Yoco hand-off
  js/reviews.js           reviews page logic (load + submit)
  js/catering.js           catering page logic (gallery + inquiry form)
  js/admin.js            admin logic: login, menu CRUD, image upload, orders, settings
  js/staff.js              staff logic: login, live order board, tap-to-advance stages
  robots.txt
  sitemap.xml

functions/
  _lib/db.js            shared Neon HTTP SQL query helper
  _lib/auth.js           shared bearer-token check (requireAdmin + requireStaff, separate secrets)
  _lib/customerAuth.js     session lookup for signed-in customers (requireCustomer)
  _lib/password.js          PBKDF2-SHA256 password hashing via Web Crypto (customer accounts)
  _lib/email.js               Resend API wrapper (password reset emails)
  _lib/md5.js             pure-JS MD5 (only needed because some gateway signature
                           specs require it, and Workers' Web Crypto doesn't have it)
  _lib/yoco.js            helper to build hosted-checkout redirect fields (Yoco)
  api/menu.js             GET  - public menu (categories + items + addons + spice levels)
  api/order.js            POST - place an order (requires a signed-in customer; server re-prices
                           every line; returns hosted-checkout redirect fields if paying online)
                           PUT  - customer self-cancel (own order only, "New" status, 2-min window)
  api/order/my.js           GET  - full order history for the signed-in customer (My Orders)
  api/auth/signup.js         POST - create a customer account, returns a session token
  api/auth/login.js           POST - sign in, returns a session token (locks after 4 failed attempts)
  api/auth/logout.js           POST - end the current session
  api/auth/me.js                 GET  - resolve the current session to a customer profile
  api/auth/forgot-password.js     POST - emails a one-time reset link via Resend
  api/auth/reset-password.js       POST - redeems the reset link, clears the lockout, signs out
                                    every session for that account
  api/payment/notify.js    POST - payment gateway server-to-server webhook (confirmations)
  api/review.js           GET/POST - review wall
  api/config.js            GET  - public site config (buffet visibility)
  api/admin/login.js         POST - owner password login, returns admin token
  api/admin/menu.js           GET/POST/PUT/DELETE - menu item CRUD
  api/admin/categories.js      GET/POST - category management
  api/admin/addons.js           GET/POST/DELETE - extras & spice-level catalogs
  api/admin/upload.js            POST - image upload to R2
  api/admin/config.js             POST - toggle buffet visibility
  api/admin/pending-orders.js      GET  - live orders monitor feed (incl. payment status)
  api/admin/orders.js               GET  - full order history (search/filter/paginate)
                                     DELETE - "Clear History" (removes Completed/Cancelled only)
  api/admin/order-status.js         POST - advance/cancel an order's status
  api/admin/stats.js                 GET  - Your Sales tab: total orders + per-category counts
  api/admin/review-reply.js          POST - owner reply to a review
  api/staff/login.js                  POST - kitchen password login, returns staff token
  api/staff/orders.js                  GET  - live kitchen board feed (New/Preparing/Ready/Collection/Delivery only,
                                        no prices - kitchen-relevant fields only)
  api/staff/order-status.js             POST - advance/cancel an order's status (kitchen)

db/schema.sql            Neon Postgres schema + seed categories/spice levels (run once)

menu images/              your existing categorized dish photos - upload these through
                           the admin dashboard's photo field per dish (Section 5); they are
                           not auto-deployed since they currently live only on this machine.
```

Files/folders starting with `_` (like `functions/_lib`) are ignored by Cloudflare Pages' router, so they're safe shared-code locations.

---

## 2. One-time setup

### 2.1 Neon Postgres (free tier)

1. Create a free project at neon.tech.
2. Open the Neon SQL editor and run the contents of `db/schema.sql` once. It creates every table and seeds your 14 menu categories (Starters, Wings, Chicken, Ribs, Beef, Stew, Seafood, Tilapia Fish, Pizza, Platters, Sides, Tripe & Cow Heels, Dessert, Drinks) plus 4 starter spice levels.
3. In Neon's dashboard, open the **Connect** panel and copy the PostgreSQL connection string into `NEON_DATABASE_URL`.

### 2.2 Cloudflare R2 (free tier: 10GB storage, no egress fee)

1. Create a bucket, e.g. `fulude-menu-images`.
2. Enable public access (either the bucket's `r2.dev` URL or attach a custom subdomain) and copy that base URL — this is `R2_PUBLIC_URL`.
3. In your Pages project **Settings > Functions > R2 bucket bindings**, add a binding named exactly `FULUDE_BUCKET` pointing at that bucket (the code in `functions/api/admin/upload.js` expects this binding name).

### 2.3 Yoco (online payment - required, checkout won't work without it)

1. Create a merchant account with the payment provider you intend to use (this repo is wired for a hosted checkout flow such as Yoco). Your gateway will provide either a hosted-checkout URL or a small redirect/POST integration.
2. Configure the gateway's hosted checkout to call back to `https://<your-deploy-origin>/api/payment/notify` (the webhook/notify URL) so the server can be told when a payment completes.
3. If your gateway supports HMAC-signed webhooks, set the signing secret in your Pages environment as `YOCO_WEBHOOK_SECRET` and this app will verify incoming webhooks against it.
4. Set the checkout URL in your environment as `YOCO_PAYMENT_URL` (or `YOCO_CHECKOUT_URL`). Optionally set `YOCO_CURRENCY` (defaults to `ZAR`).

No notify-url whitelisting is usually required — the notify URL only needs to be publicly reachable so the gateway can POST payment confirmations to `/api/payment/notify`.

### 2.4 Resend (password reset emails - required, "Forgot password" won't work without it)

1. Sign up for a free account at [resend.com](https://resend.com) (100 emails/day free, plenty for a single cafe's password resets).
2. Under **API Keys**, create a key — this is `RESEND_API_KEY`.
3. Under **Domains**, either verify your own domain (best long-term, e.g. `noreply@fuludescafe.co.za`) or use Resend's shared testing domain while you're setting things up. Whatever address you end up sending from is `RESEND_FROM_EMAIL`.
4. That's it — `functions/api/auth/forgot-password.js` handles the rest.

If you skip this section, account signup/login/checkout all still work fine — only "Forgot password" breaks, returning a clear server error instead of silently failing.

### 2.5 Google Sign-In (optional - customer accounts still work without it)

Google Sign-In shares one client ID across two different places. Both must be
set to the SAME value.

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth 2.0 Client ID** of type **Web application**.
2. Under **Authorized JavaScript origins**, add every domain you'll load this
   site from - your production domain, your `*.pages.dev` preview domain, and
   `http://localhost:8788` (or whatever port `wrangler pages dev` uses) if you
   want to test locally.
3. Copy the generated Client ID. It is **not a secret** - it's designed to be
   public and ships inside the page HTML, unlike every other key in this
   README. Set it in both places:
   - **Server-side:** Cloudflare Pages > Settings > Environment variables >
     `GOOGLE_CLIENT_ID` (Production and Preview). This is required, not
     optional - `functions/api/auth/google.js` rejects all Google sign-ins
     with a 500 if this isn't set, since without it any Google ID token from
     any app would otherwise be accepted.
   - **Client-side:** find `<meta name="google-client-id" content="...">` in
     `public/home.html`, `public/catering.html`, `public/contact.html`,
     `public/reviews.html`, and `public/menu.html`, and replace
     `YOUR_GOOGLE_OAUTH_CLIENT_ID` with the same Client ID. This site is
     static with no build step, so Cloudflare's env var is invisible to the
     browser - the meta tag is the only way the frontend learns the client
     ID. It's safe to commit the real value here.

If you skip this section, the "Sign in / Create account with Google" buttons
simply stay hidden and customers fall back to email/password - nothing else
breaks.

One account-linking behavior worth knowing: if someone already has a
password-based account under an email and later uses Google Sign-In with that
same email for the first time, the server returns `account_exists_use_password`
rather than silently attaching the Google account - they need to sign in with
their password at least once before Google Sign-In will link to that account.

### 2.6 Cloudflare Pages

1. Push this folder to a GitHub repo and connect it in Cloudflare Pages, **or** deploy directly with `npx wrangler pages deploy public`.
2. Build output directory: `public`. No build command needed (it's static + Functions).
3. Under **Settings > Environment variables**, add for both Production and Preview:

   | Variable              | Value                                       |
   | --------------------- | ------------------------------------------- |
  | `NEON_DATABASE_URL`   | PostgreSQL connection string from step 2.1  |
   | `R2_PUBLIC_URL`       | from step 2.2                               |
   | `YOCO_PAYMENT_URL`    | hosted checkout URL (gateway-provided)      |
   | `YOCO_CHECKOUT_URL`   | alternate hosted checkout URL (optional)    |
   | `YOCO_CURRENCY`       | Currency code (default `ZAR`)               |
   | `YOCO_WEBHOOK_SECRET` | HMAC secret used to verify webhook payloads |
   | `RESEND_API_KEY`      | from step 2.4                               |
   | `RESEND_FROM_EMAIL`   | from step 2.4                               |
   | `GOOGLE_CLIENT_ID`    | from step 2.5 (also goes in the HTML meta tags) |

For local development, admin and staff credentials are read from `.dev.vars` (Wrangler Pages Functions reads this automatically). Admin uses `ADMIN_EMAIL`/`ADMIN_PASSWORD`; staff uses `STAFF_EMAIL`/`STAFF_PASSWORD`. `.dev.vars` is untracked and ignored by Git. No database is required for local login — sessions are stored in memory when Neon is not configured.

4. Deploy. Visit `/admin.html`, log in with the email/password from `.dev.vars`, and start adding dishes. Give kitchen staff the `/staff.html` link and their separate email/password.

Payment is strictly online now — there is no pay-at-pickup/delivery fallback. If you skip section 2.3, checkout is broken end-to-end: customers will get an error at the "Place Order" step telling them to contact the cafe directly, so treat `YOCO_PAYMENT_URL` (or `YOCO_CHECKOUT_URL`) as required, not optional.

Customer accounts are required to check out too (see the next section) — the account system itself (signup/login/order history) works with just Neon configured, but "Forgot password" needs `RESEND_API_KEY`/`RESEND_FROM_EMAIL` from step 2.4.

For local development, change admin/staff passwords directly in `.dev.vars`; never commit that file. When deploying later, configure the same variables as Cloudflare Pages secrets or use a separate secret manager.

---

## 3. How the pieces fit together

- **Customer menu (`/api/menu`)** only returns items with `is_visible = true`. Use this to hide desserts (or anything seasonal) until you're ready to sell them that day — flip "Show on Menu" off in the admin Menu tab. Category tabs follow the same logic: a category only appears on the customer site while it has at least one visible dish in it, so a category that isn't offered every day (e.g. Starters or Dessert) simply disappears from the menu instead of showing an empty tab, and reappears automatically the moment you make a dish in it visible again. This only looks at `is_visible`, not stock — a sold-out-but-visible dish still keeps its category's tab showing.
- **Sold out is data-driven, not a manual toggle.** Each menu item has a "Stock Quantity" in the admin Menu tab, editable any time. Leave it blank and the dish is always available (untracked, e.g. drinks you never run out of). Set a number and every order automatically decrements it (`functions/api/order.js`); the moment it hits 0 the item flips to a Sold Out badge on the customer menu (greyed out, can't be added to cart) and the admin item list shows "Sold Out" instead of a count. Restock by editing the number back up. This is separate from "Show on Menu" (`is_visible`), which hides an item from customers entirely regardless of stock.
- **Specials:** the admin Specials tab lets you pick any existing dish and set a discounted price for it — no need to recreate the item. While a special is active, that discounted price _is_ the dish's real selling price everywhere (menu card, cart, checkout), not just a display trick; `functions/api/order.js` re-checks it from Neon the same way it re-checks every other price. On the customer site, any active special shows a red "Special" badge and a struck-through original price right on its menu card, and a red "Save on Meals" button appears below the search bar (only when at least one visible, in-stock item is on special) that opens a list of every special with the exact amount saved. End a special any time from the same admin tab — the dish just goes back to its regular price.
- **Spice level & extras** only appear on a dish, in both the admin form and the customer card, if that dish's "Spice Level" / "Accepts Extras" checkboxes are on. Extras themselves are a shared catalog (Extras tab) — tick which ones apply to which dish when you edit it.
- **Pricing is never trusted from the browser.** `functions/api/order.js` re-looks-up every item's and addon's price in Neon before totaling the bill, so a tampered checkout request can't undercharge.
- **Security & audit:** login/signup/forgot-password endpoints are rate-limited, customer-entered text is sanitized before it is stored, and sensitive actions like logins, logouts, order status changes, and payment webhook events are recorded in the `audit_logs` table.
- **Cart editing:** customers can change quantity or remove any line from the cart panel before checking out (`public/js/main.js` `changeLineQuantity()` / the × remove button).
- **Order monitor:** the admin Orders tab polls `/api/admin/pending-orders` every 30 seconds and plays a repeating tone (Web Audio API — no ringtone file to host) until you advance the order (New → Preparing → Ready → Collection/Delivery → Completed) or cancel it.
- **Buffet section:** hidden on the customer site until you flip it on under admin Settings.
- **Photo galleries:** each dish supports up to 6 photos (`MAX_IMAGES` in `functions/api/admin/menu.js`). The first uploaded photo is the "cover" shown on the menu card; customers tap a card's photo to open a swipeable lightbox through all of them. If you already ran an earlier version of `db/schema.sql`, just run the new `menu_item_images` table block again in the Neon SQL editor — it's additive and won't touch existing data.
- **Catering inspiration gallery:** a static, non-orderable photo strip under Catering Services (`public/images/catering/`) — just for giving people ideas, no admin management needed. Swap those files for new ones any time to refresh it.
- **Online payment (mandatory):** every order must be paid online — there is no "Pay at Pickup/Delivery" option. Clicking "Continue to Payment" at checkout redirects the customer to the configured hosted checkout page; the order is already saved in Neon at that point with `payment_status = 'awaiting'`, so nothing is lost if they abandon the payment. The payment gateway confirms the transaction directly to our server (`functions/api/payment/notify.js`, not the customer's browser), which is the only thing that ever flips an order to `payment_status = 'paid'`. The admin Orders tab shows a badge per order (Awaiting Payment / Paid Online / Payment Failed) and only rings the kitchen alert once the gateway confirms payment — an order that's still `awaiting` payment never reaches the kitchen or Staff Portal board.
- **Cancelling a paid order:** cancelling in admin/staff only changes the order's status — it does **not** trigger a refund automatically. When a paid order is cancelled, the system sets `orders.refund_needed = TRUE` so it can be tracked in the admin History view. Both the admin dashboard and Staff Portal show a confirm prompt before cancelling an order that's already `payment_status = 'paid'`, reminding whoever's cancelling that a refund is owed (the admin prompt includes the amount and `payment_ref`; staff just get told to flag it to Fulufhelo, since they don't have merchant dashboard access). Any order that's Cancelled-but-paid also gets a red **"Refund Needed"** badge wherever it's shown in the admin History tab, and there's a matching **"Refund Needed"** option in the History status filter dropdown to pull up every one of them at once. None of this processes the refund for you — it's purely a "don't forget" flag. To actually refund, log into your payment gateway's merchant dashboard, find the transaction under Transaction History (matched via `orders.payment_ref`), and issue a full or partial refund from there; the gateway will email the customer a confirmation automatically.
- **Kitchen never sees unpaid orders:** since payment is mandatory, `functions/api/staff/orders.js` only ever returns orders with `payment_status = 'paid'` — an order that's still `awaiting` confirmation or came back `failed` simply never appears on the Staff Portal board, so nobody in the kitchen can accidentally start cooking (or serve) something that hasn't actually been paid for. The admin dashboard still shows awaiting/failed orders (dimmed, in the Live Orders tab) for visibility/follow-up, but advancing one past New also triggers a confirm-are-you-sure prompt, and the "ring the kitchen" alert only fires once payment is confirmed `paid`.
- **Order type:** collection, delivery, or dine-in. Delivery requires an address; dine-in has an optional table number field (`orders.table_number`) so kitchen/waitstaff know where to bring the food - neither is required for collection.
- **No card data ever touches this system.** The customer types their card number/CVV/expiry directly on the gateway's hosted page, never ours - the only payment field stored in `orders` is `payment_ref`, the gateway's transaction id (harmless, like an order number).
- **Order History tab (admin):** shows every order regardless of status, with search (name/phone/order #) and a status filter — separate from the live Orders queue, which only ever shows what still needs action. A **Clear History** button permanently deletes Completed/Cancelled orders (live orders still in New/Preparing/Ready/Collection/Delivery are never touched by it); this also lowers the counts on Your Sales, since those are computed live from the same table.
- **Your Sales tab (admin):** a total-orders counter plus a hand-drawn SVG pie chart (`functions/api/admin/stats.js`) showing how many orders touched each menu category, with a hover tooltip and a colour-keyed legend down the side. No charting library — just plain SVG, in keeping with the vanilla-JS constraint.
- **Customer accounts (required to check out):** every customer signs up (name, email, password) or signs in before placing an order — there's no guest checkout. The account icon in the nav (`public/index.html` `#accountNavBtn`, styled with Bootstrap Icons) opens a combined sign-in/create-account modal when signed out, or an account menu (My Orders, Log Out) when signed in. A session is a random token stored in `customer_sessions` in Neon on every authenticated request; sessions now expire after 7 days, and any password reset invalidates all existing sessions for that account. Passwords are hashed with PBKDF2-SHA256 via the Web Crypto API (`functions/_lib/password.js`) — never bcrypt, since Workers can't run native bindings, and never stored in plain text. After **4 wrong passwords in a row**, the account locks (`customers.is_locked`) and further login attempts are refused — correct password or not — until the customer resets their password, which also clears the lockout. "Forgot password" emails a one-hour link via Resend (`functions/_lib/email.js`, `functions/api/auth/forgot-password.js`); clicking it opens a reset form right on the homepage (`/?reset_token=...`).
- **My Orders (customer):** now that accounts are required, this is simply every order ever placed by the signed-in customer (`GET /api/order/my`, ordered newest first) — no expiry, no localStorage bookkeeping, it's just the account's permanent history. Each order shows a live animated status tracker with customer-facing labels (Order received → Preparing → The order is ready → Ready for collection/Out for delivery → Completed, or a distinct Cancelled state), polled every 15 seconds while the My Orders window is open so it updates as the kitchen moves the order along — no manual refresh needed. The full itemized receipt is collapsed by default behind a "View Receipt" button.
- **Customer self-cancel (2-minute window):** while an order is still `New`, its My Orders card shows a "Cancel Order" button with a live countdown, for exactly 2 minutes from `created_at` (`CUSTOMER_CANCEL_WINDOW_MS` in both `public/js/main.js` and `functions/api/order.js` — keep them in sync if you ever change it). `PUT /api/order` (customer session required, and only lets you cancel your own order) re-checks both conditions server-side before cancelling, so a stale button or a tampered request can't cancel something that's already being prepared, past the window, or someone else's order. Cancelling flips the order to `Cancelled`, which is all it takes to drop it off both the admin Live Orders and Staff Portal boards (they only ever query `status IN ('New','Preparing','Ready')`) — and if it was already paid, the same "Refund Needed" flag described above appears for Fulufhelo to action.
- **Dine-in arrival time:** when a customer selects Dine In at checkout, the generic "Preferred Time" dropdown is replaced with a time picker asking what time they'll arrive (optional — defaults to "As soon as possible" if left blank). It's stored in the same `orders.pickup_time` field every other order type uses, so it shows up automatically wherever pickup_time is already displayed, including the Staff Portal ticket and the admin order card.
- **Staff Portal (kitchen, `/staff.html`):** a separate page with its own email/password login (STAFF_PASSWORD) — kitchen staff never get access to menu editing, sales figures, or settings. It's a Kanban board (New / Preparing / Ready / Collection / Delivery) polled every 15 seconds so tickets appear automatically as customers order, with a repeating tone (same Web Audio approach as the admin dashboard) for new tickets. Staff can drag tickets between columns or use the status buttons to advance them through the same New→Preparing→Ready→Collection/Delivery→Completed lifecycle as the admin dashboard (`functions/api/staff/order-status.js` shares the same status values as `functions/api/admin/order-status.js`); a Cancel button is always available too. Completed/Cancelled tickets simply stop being returned by `/api/staff/orders` and disappear off the board. Kitchen tickets deliberately exclude prices/totals (`functions/api/staff/orders.js`) — staff see only what they need to cook and fulfil the order.

## 4. Not included (out of scope for this pass)

- **Web Push notifications** to the admin's phone (VAPID keys, service worker subscriptions) — the polling + in-tab sound alert covers the same need with far less moving parts. Can be added later if you want true background push.
- **Catering inquiry storage** — the catering form currently just shows a confirmation message; it isn't saved to Neon yet. Say the word and it's a small addition (mirrors `review.js`).
- **Delivery address geocoding/validation** — address is stored as free text.
- **Automatic refunds / retry-payment flow** — if an online payment fails or is cancelled, the order stays saved but `payment_status` stops at `awaiting`/`failed`; there's no self-serve "try paying again" link yet, so you'd contact the customer (their phone number is on the order) to either take payment another way or have them re-checkout. Refunds are handled manually from your Yoco dashboard, same as any yoco merchant.
- **Email verification on signup** — a customer can sign up with any email address without proving they own it (there's no "click to confirm your email" step). This only really matters for password reset, since that's the one flow that depends on the account owner actually receiving mail at that address.

---

## 5. Getting your existing dish photos online

The `menu images/` folder (chicken, tripe & cow heels, tilapia, meat platter, catering inspo) lives on your computer, not the internet, so the site can't load them directly. For each dish:

1. Log into `/admin.html` → **Menu** tab → **Add Menu Item**.
2. Fill in name, category, price, description.
3. Under **Photo**, choose the matching file from `menu images/...`. The browser compresses it to a WebP under 300KB automatically, uploads it to R2, and fills in the image URL for you.
4. Save. The dish appears live on the customer menu immediately (unless "Show on Menu" is off).

Repeat for each photo — this also lets you write a proper name/description/price per dish rather than guessing from a filename.
