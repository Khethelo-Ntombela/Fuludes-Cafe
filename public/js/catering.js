// Catering-page logic: renders the static inspiration gallery

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

// The form opens the customer's email app with the message ready to send.
const CATERING_INQUIRY_EMAIL = "orders@fuludescafe.co.za";

// Events need at least 3 days' notice so the kitchen has time to prepare.
const CATERING_NOTICE_DAYS = 3;
const catDateInput = document.getElementById("catDate");

/** Earliest event date as "YYYY-MM-DD": today + 3 days. */
function earliestCateringDate() {
  const d = new Date();
  d.setDate(d.getDate() + CATERING_NOTICE_DAYS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function checkCateringDate() {
  const earliest = earliestCateringDate();
  catDateInput.min = earliest;
  catDateInput.setCustomValidity(
    catDateInput.value && catDateInput.value < earliest
      ? `Please choose a date at least ${CATERING_NOTICE_DAYS} days from today, so we have time to prepare.`
      : "",
  );
}
catDateInput.addEventListener("input", checkCateringDate);
catDateInput.addEventListener("change", checkCateringDate);
checkCateringDate();

document.getElementById("cateringForm").addEventListener("submit", (e) => {
  e.preventDefault();
  checkCateringDate();
  if (!catDateInput.reportValidity()) return;
  const val = (id) => document.getElementById(id).value.trim();
  const name = val("catName");
  const body = [
    "Hi Fulude's Cafe,",
    "",
    "I'd like to enquire about your catering services.",
    "",
    `Name: ${name}`,
    `Email: ${val("catEmail")}`,
    `Phone: ${val("catPhone")}`,
    `Event date: ${val("catDate")}`,
    `Event address: ${val("catAddress")}`,
    `Estimated guests: ${val("catGuests")}`,
    "",
    "Additional details:",
    val("catMessage") || "-",
  ].join("\n");
  const subject = `Catering enquiry - ${name}${val("catDate") ? ` - ${val("catDate")}` : ""}`;
  window.location.href = `mailto:${CATERING_INQUIRY_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

  // Details are in the email app now, so reset the form. WhatsApp is an optional fallback.
  e.target.reset();
  showCateringSent(body);
});

const CATERING_WHATSAPP = "27663649016";

function showCateringSent(body) {
  const form = document.getElementById("cateringForm");
  let note = document.getElementById("cateringSentNote");
  if (!note) {
    note = document.createElement("div");
    note.id = "cateringSentNote";
    note.className = "catering-sent-note";
    note.setAttribute("role", "status");
    form.appendChild(note);
  }
  const waLink = `https://wa.me/${CATERING_WHATSAPP}?text=${encodeURIComponent(body)}`;
  note.innerHTML = `
    <p><strong>Thank you!</strong> Your enquiry has opened in your email app - just press <strong>Send</strong> there. We'll get back to you within 24 hours.</p>
    <div class="catering-sent-actions">
      <button type="button" class="btn btn-primary" id="cateringSentOk">OK</button>
      <a href="${waLink}" target="_blank" rel="noopener" class="catering-sent-wa">Email didn't open? Send it on WhatsApp instead</a>
    </div>`;
  note.style.display = "block";
  document.getElementById("cateringSentOk").addEventListener("click", () => {
    note.style.display = "none";
  });
}

renderCateringGallery();
