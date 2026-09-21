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

// Simple inquiry - no backend endpoint yet, shows a confirmation locally;
// wire this up to an /api/catering route if the cafe wants inquiries saved to Neon too.
document.getElementById("cateringForm").addEventListener("submit", (e) => {
  e.preventDefault();
  alert("Thank you for your inquiry! Our catering team will contact you within 24 hours.");
  e.target.reset();
});

renderCateringGallery();
