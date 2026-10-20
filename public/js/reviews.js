// Reviews-page logic: loads the review wall from /api/review and submits new reviews

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
    setTimeout(() => {
      loadReviews();
      loadMyReviews();
    }, 800);
  } catch {
    alert("Sorry, we couldn't submit your review. Please try again.");
  }
});

// ---------------------------------------------------------------------------
// "Your Reviews": the signed-in customer's own reviews and their status.
// A rejected review shows the admin's reason and can be edited and sent again.
// A pending or approved review cannot be edited (the server enforces this too).
// ---------------------------------------------------------------------------
function customerSignedIn() {
  return (
    typeof currentCustomer !== "undefined" && currentCustomer &&
    typeof customerToken !== "undefined" && customerToken
  );
}

function myReviewHtml(r) {
  const stars = `${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}`;
  const badge = {
    pending: `<span class="my-review-badge pending">Waiting for approval</span>`,
    approved: `<span class="my-review-badge approved">Published</span>`,
    rejected: `<span class="my-review-badge rejected">Not published</span>`,
  }[r.status] || "";
  const reason =
    r.status === "rejected"
      ? `<div class="my-review-reason"><strong>Why it wasn't published:</strong> ${escapeHtml(r.rejection_reason || "Please check your review and try again.")}</div>
         <button type="button" class="btn btn-primary my-review-edit-btn" data-edit-my-review="${r.id}">Edit my review</button>`
      : "";
  const form =
    r.status === "rejected"
      ? `<form class="my-review-edit-form" data-my-review-form="${r.id}" style="display: none">
           <div class="form-group"><label>Your name</label><input type="text" name="customer_name" maxlength="100" value="${escapeHtml(r.customer_name)}" required /></div>
           <div class="form-group"><label>Rating</label>
             <select name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${n === r.rating ? "selected" : ""}>${"★".repeat(n)}</option>`).join("")}</select></div>
           <div class="form-group"><label>Your review</label><textarea name="comment" rows="4" maxlength="1000" required>${escapeHtml(r.comment)}</textarea></div>
           <p class="form-error" data-my-review-error style="display: none"></p>
           <button type="submit" class="btn btn-primary">Send for approval</button>
           <button type="button" class="btn my-review-cancel-btn" data-cancel-my-review="${r.id}">Cancel</button>
         </form>`
      : "";
  return `
    <div class="my-review-card">
      <div class="review-card-header">
        <span class="review-card-stars">${stars}</span>
        ${badge}
      </div>
      <p class="review-card-comment">${escapeHtml(r.comment)}</p>
      ${r.owner_reply ? `<div class="review-card-reply"><strong>Fulude's Cafe:</strong> ${escapeHtml(r.owner_reply)}</div>` : ""}
      ${reason}
      ${form}
    </div>`;
}

async function loadMyReviews() {
  const wrap = document.getElementById("myReviews");
  const list = document.getElementById("myReviewsList");
  if (!wrap || !list) return;
  if (!customerSignedIn()) {
    wrap.style.display = "none";
    return;
  }
  try {
    const res = await fetch("/api/review/mine", { headers: { Authorization: `Bearer ${customerToken}` } });
    if (!res.ok) throw new Error("failed");
    const data = await res.json();
    const reviews = data.reviews || [];
    if (!reviews.length) {
      wrap.style.display = "none";
      return;
    }
    wrap.style.display = "";
    list.innerHTML = reviews.map(myReviewHtml).join("");

    list.querySelectorAll("[data-edit-my-review]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.dataset.editMyReview;
        list.querySelector(`[data-my-review-form="${id}"]`).style.display = "";
        btn.style.display = "none";
      }),
    );
    list.querySelectorAll("[data-cancel-my-review]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = btn.dataset.cancelMyReview;
        list.querySelector(`[data-my-review-form="${id}"]`).style.display = "none";
        const edit = list.querySelector(`[data-edit-my-review="${id}"]`);
        if (edit) edit.style.display = "";
      }),
    );
    list.querySelectorAll("form[data-my-review-form]").forEach((form) =>
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const errEl = form.querySelector("[data-my-review-error]");
        errEl.style.display = "none";
        try {
          const res2 = await fetch("/api/review/edit", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
            body: JSON.stringify({
              review_id: Number(form.dataset.myReviewForm),
              customer_name: form.customer_name.value.trim(),
              rating: Number(form.rating.value),
              comment: form.comment.value.trim(),
            }),
          });
          const out = await res2.json().catch(() => ({}));
          if (!res2.ok || !out.success) {
            errEl.textContent = out.error || "Couldn't update your review.";
            errEl.style.display = "block";
            loadMyReviews(); // the status may have changed (for example it was approved)
            return;
          }
          loadMyReviews();
        } catch {
          errEl.textContent = "Sorry, we couldn't update your review. Please try again.";
          errEl.style.display = "block";
        }
      }),
    );
  } catch {
    wrap.style.display = "none";
  }
}

// The sign-in state arrives after the page loads, so refresh whenever it changes
window.addEventListener("fulude:auth-changed", loadMyReviews);

loadReviews();
loadMyReviews();
