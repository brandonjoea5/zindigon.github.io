// Zindigon League | pricing page.
// Renders Free/Plus/Premier from GET /billing/plans (see
// workers/zindigon-league-api/src/index.js) — nothing about prices or
// allowances is hard-coded here, so an admin can change them in Supabase
// without touching this file. Depends on auth-shared.js (esc, LeagueAuth,
// openAccountModal) and billing-shared.js (fetchBillingPlans, startCheckout)
// being loaded first.

const pricingStatusEl = document.getElementById("pricingStatus");
const pricingGridEl = document.getElementById("pricingGrid");

function setPricingStatus(message, type) {
  if (!message) { pricingStatusEl.className = "status-line"; pricingStatusEl.textContent = ""; return; }
  pricingStatusEl.textContent = message;
  pricingStatusEl.className = `status-line show ${type || ""}`;
}

function fmtPlanPrice(cents) {
  if (!cents) return "Free";
  return `$${(cents / 100).toFixed(2)}/mo`;
}

async function loadPlans() {
  setPricingStatus("Loading plans…");
  try {
    const plans = await fetchBillingPlans();
    renderPlans(plans);
    setPricingStatus("");
  } catch (err) {
    if (err.code === "billing_not_configured") {
      setPricingStatus("Plans aren't set up yet — check back soon.", "warn");
    } else {
      setPricingStatus(err.message || "Could not load plans right now.", "error");
    }
  }
}

function renderPlans(plans) {
  if (!plans.length) {
    pricingGridEl.innerHTML = `<div class="lp-empty">No plans are available right now.</div>`;
    return;
  }

  pricingGridEl.innerHTML = plans.map((p) => `
    <div class="lp-plan-card${p.slug === "plus" ? " featured" : ""}">
      <h3>${esc(p.display_name)}</h3>
      <div class="lp-plan-price">${fmtPlanPrice(p.price_cents)}</div>
      <ul class="lp-plan-features">
        <li>${p.monthly_review_allowance} AI match review${p.monthly_review_allowance === 1 ? "" : "s"}/mo</li>
        <li>${p.monthly_followup_allowance} follow-up question${p.monthly_followup_allowance === 1 ? "" : "s"}/mo</li>
        <li>${p.saved_profile_limit} saved profiles</li>
      </ul>
      ${p.price_cents > 0
        ? `<button type="button" class="btn btn-primary" data-choose-plan="${esc(p.slug)}">Choose ${esc(p.display_name)}</button>`
        : `<span class="lp-plan-current-note">Always free</span>`}
    </div>`).join("");

  pricingGridEl.querySelectorAll("[data-choose-plan]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (typeof LeagueAuth === "undefined" || !LeagueAuth.isSignedIn()) {
        alert("Sign in first, then choose a plan.");
        if (typeof openAccountModal === "function") openAccountModal("signin");
        return;
      }
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = "Redirecting…";
      try {
        await startCheckout(btn.dataset.choosePlan);
      } catch (err) {
        alert(err.message || "Could not start checkout.");
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });
}

document.addEventListener("DOMContentLoaded", loadPlans);
