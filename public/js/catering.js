/**
 * public/js/catering.js
 * -----------------------------------------------------------------------
 * Catering-page logic: renders the static inspiration gallery (opens in
 * the shared lightbox from site.js) and handles the inquiry form.
 * Requires site.js to be loaded first.
 * -----------------------------------------------------------------------
 */

const CATERING_GALLERY_PHOTOS = [
  "images/catering/cat.jpeg",
  "images/catering/cat_1.png",
  "images/catering/cat_2.jpeg",
  "images/catering/cat_3.jpeg",
  "images/catering/cat_4.jpeg"
];

function renderCateringGallery() {
  const gallery = document.getElementById("cateringGallery");
  gallery.innerHTML = CATERING_GALLERY_PHOTOS.map(
    (src, idx) => `
    <div class="catering-gallery-item" data-idx="${idx}">
      <img src="${src}" alt="Catering spread inspiration ${idx + 1}" loading="lazy" />
    </div>
  `
  ).join("");

  gallery.querySelectorAll(".catering-gallery-item").forEach((el) => {
    el.addEventListener("click", () => openLightboxWithPhotos(CATERING_GALLERY_PHOTOS, parseInt(el.dataset.idx, 10)));
  });
}

// Catering inquiries go to orders@fuludescafe.co.za: the form opens the
// customer's email app with a ready-to-send message (no email service needed).
const CATERING_INQUIRY_EMAIL = "orders@fuludescafe.co.za";

document.getElementById("cateringForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const val = (id) => document.getElementById(id).value.trim();
  const name = val("catName");
  const body = [
    "Hi Fulude's Cafe,",
    "",
    "I'd like to book your catering service.",
    "",
    `Name: ${name}`,
    `Email: ${val("catEmail")}`,
    `Phone: ${val("catPhone")}`,
    `Event date: ${val("catDate")}`,
    `Estimated guests: ${val("catGuests")}`,
    "",
    "Additional details:",
    val("catMessage") || "-",
  ].join("\n");
  const subject = `Catering inquiry - ${name}${val("catDate") ? ` - ${val("catDate")}` : ""}`;
  window.location.href = `mailto:${CATERING_INQUIRY_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  let note = document.getElementById("cateringSentNote");
  if (!note) {
    note = document.createElement("p");
    note.id = "cateringSentNote";
    note.className = "catering-sent-note";
    e.target.appendChild(note);
  }
  note.innerHTML = `Your email app should now open with your inquiry - just press <strong>Send</strong>. If nothing opened, email us at <a href="mailto:${CATERING_INQUIRY_EMAIL}">${CATERING_INQUIRY_EMAIL}</a> or WhatsApp <a href="https://wa.me/27663649016">+27 66 364 9016</a>.`;
});

renderCateringGallery();
