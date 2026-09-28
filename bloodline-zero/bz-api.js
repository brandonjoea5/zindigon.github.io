// Bloodline Zero | Worker API helpers.
// Talks to workers/zindigon-bloodlinezero-api. Depends on
// assets/auth-shared.js being loaded first (uses window.ZindigonAuth's
// Supabase client for the signed-in user's access token, same contract
// as lol/billing-shared.js).

const BZ_API_BASE = "https://zindigon-bloodlinezero-api.brandonjoea3.workers.dev";

async function bzFetch(path, options = {}) {
  const res = await fetch(`${BZ_API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const err = new Error(body?.error || body?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function bzAuthedFetch(path, options = {}) {
  const { data } = await window.ZindigonAuth.sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) {
    const err = new Error("Sign in required.");
    err.status = 401;
    throw err;
  }
  return bzFetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {}),
    },
  });
}

// Public — no sign-in required.
async function bzFetchEpisodes() {
  const data = await bzFetch("/episodes");
  return data.episodes || [];
}

async function bzFetchPricing() {
  return bzFetch("/pricing");
}

// Gated — returns the episode with `body` when free or already owned;
// throws with .status 401 (sign in) or a body of { error: "not_purchased",
// price_cents } via .body when locked.
async function bzFetchEpisode(number) {
  const { data } = await window.ZindigonAuth.sb.auth.getSession();
  const token = data.session?.access_token;
  const res = await bzFetch(`/episodes/${number}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return res.episode;
}

async function bzFetchLibrary() {
  const data = await bzAuthedFetch("/library");
  return data.library || [];
}

async function bzPostProgress(episodeNumber, percent) {
  return bzAuthedFetch("/progress", {
    method: "POST",
    body: JSON.stringify({ episodeNumber, percent }),
  });
}

// Redirects the browser to Stripe Checkout. Access is only ever granted
// by the server-side webhook — this redirect alone never unlocks
// anything (see checkout.html / library.html for the return legs).
async function bzStartCheckout(episodeNumbers) {
  const { url } = await bzAuthedFetch("/billing/checkout", {
    method: "POST",
    body: JSON.stringify({ episodeNumbers }),
  });
  window.location.href = url;
}
