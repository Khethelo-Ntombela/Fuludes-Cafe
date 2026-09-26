/**
 * public/js/reviews.js
 * -----------------------------------------------------------------------
 * Reviews-page logic: loads the review wall from /api/review and submits
 * new reviews. Requires site.js to be loaded first.
 * -----------------------------------------------------------------------
 */

async function loadReviews() {
  const list = document.getElementById("reviewsList");
  try {
    const res = await fetch("/api/review");
    const data = await res.json();
    const reviews = data.reviews || [];
    if (reviews.length === 0) {
      list.innerHTML = `<p class="menu-empty">No reviews yet - be the first to leave one!</p>`;
      return;
    }
    list.innerHTML = reviews
      .map(
        (r) => `
      <div class="review-card">
        <div class="review-card-header">
          <span class="review-card-name">${r.customer_name}</span>
          <span class="review-card-stars">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>
        </div>
        <p class="review-card-comment">${r.comment}</p>
        ${r.items && r.items.length ? `<div class="review-card-ordered"><i class="fas fa-utensils"></i> Ordered: ${escapeHtml(r.items.join(", "))}</div>` : ""}
        ${r.owner_reply ? `<div class="review-card-reply"><strong>Fulude's Cafe:</strong> ${r.owner_reply}</div>` : ""}
      </div>
    `,
      )
      .join("");
  } catch {
    list.innerHTML = `<p class="menu-empty">Couldn't load reviews right now.</p>`;
  }
}

document.getElementById("reviewForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (
    typeof currentCustomer === "undefined" ||
    !currentCustomer ||
    typeof customerToken === "undefined" ||
    !customerToken
  ) {
    const message = "Please sign in before submitting a review.";
    const target = document.getElementById("reviewFormMessage");
    if (target) {
      target.textContent = message;
      target.className = "form-error";
      target.style.display = "block";
    } else {
      alert(message);
    }
    return;
  }
  const nameInput = document.getElementById("reviewName");
  const ratingSelect = document.getElementById("reviewRating");
  const commentInput = document.getElementById("reviewComment");
  const msgEl = document.getElementById("reviewFormMessage");
  if (msgEl) {
    msgEl.style.display = "none";
    msgEl.textContent = "";
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (typeof customerToken !== "undefined" && customerToken)
      headers.Authorization = `Bearer ${customerToken}`;
    const res = await fetch("/api/review", {
      method: "POST",
      headers,
      body: JSON.stringify({
        customer_name: nameInput.value.trim(),
        rating: parseInt(ratingSelect.value, 10),
        comment: commentInput.value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      const err = data && data.error ? data.error : "Failed to submit review";
      if (msgEl) {
        msgEl.textContent = err;
        msgEl.className = "form-error";
        msgEl.style.display = "block";
      } else {
        alert(err);
      }
      return;
    }
    // show a thank-you message and auto-hide after 5 seconds
    if (msgEl) {
      msgEl.textContent =
        data.message || "Thank you! your review has been submitted";
      msgEl.className = "form-success";
      msgEl.style.display = "block";
      setTimeout(() => {
        msgEl.style.display = "none";
        msgEl.textContent = "";
      }, 5000);
    } else {
      alert(data.message || "Thank you! your review has been submitted");
    }
    e.target.reset();
    // refresh approved reviews only after a short delay (moderated reviews won't appear immediately)
    setTimeout(() => loadReviews(), 800);
  } catch {
    alert("Sorry, we couldn't submit your review. Please try again.");
  }
});

loadReviews();
