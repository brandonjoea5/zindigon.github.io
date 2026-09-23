// Zindigon League | billing + AI review API helpers.
// Talks to the same zindigon-league-api Worker as app.js, but the Phase 2
// authenticated routes (see workers/zindigon-league-api/src/index.js) —
// every authed call here attaches the signed-in user's Supabase access
// token as `Authorization: Bearer <token>`, verified Worker-side against
// Supabase's own /auth/v1/user endpoint. Depends on auth-shared.js being
// loaded first (uses the `sb` client it creates).

const BILLING_WORKER_BASE = "https://zindigon-league-api.brandonjoea3.workers.dev";

async function authedFetch(path, options = {}) {
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Sign in required.");

  const res = await fetch(`${BILLING_WORKER_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const message = body?.error?.message || `Request failed (${res.status})`;
    const err = new Error(message);
    err.code = body?.error?.code;
    err.status = res.status;
    throw err;
  }
  return body;
}

// Public — no sign-in required, mirrors the Worker's GET /billing/plans.
async function fetchBillingPlans() {
  const res = await fetch(`${BILLING_WORKER_BASE}/billing/plans`);
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const message = body?.error?.message || `Request failed (${res.status})`;
    const err = new Error(message);
    err.code = body?.error?.code;
    err.status = res.status;
    throw err;
  }
  return body.plans || [];
}

async function fetchBillingStatus() {
  return authedFetch("/billing/status");
}

// Redirects the browser to Stripe Checkout. The success/cancel return is
// handled back on our own pages (app.js's handleCheckoutReturn) — the
// redirect itself never grants access; only the server-side webhook does.
async function startCheckout(planSlug) {
  const { url } = await authedFetch("/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ plan: planSlug }),
  });
  window.location.href = url;
}

async function openBillingPortal() {
  const { url } = await authedFetch("/billing/portal", { method: "POST" });
  window.location.href = url;
}

async function requestAiReview({ matchId, platform, puuid, mode, question }) {
  return authedFetch("/ai/review", {
    method: "POST",
    body: JSON.stringify({ matchId, platform, puuid, mode, question }),
  });
}

async function requestAiFollowup({ matchId, question, reviewMode, reviewQuestion }) {
  return authedFetch("/ai/followup", {
    method: "POST",
    body: JSON.stringify({ matchId, question, reviewMode, reviewQuestion }),
  });
}

