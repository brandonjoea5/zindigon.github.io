// Zindigon League | search + match-history UI
// Talks to the zindigon-league-api Cloudflare Worker (public, unauthenticated
// endpoints — see workers/zindigon-league-api/src/index.js for the routes
// and response shapes this file assumes).
const WORKER_BASE = "https://zindigon-league-api.brandonjoea3.workers.dev";
const PAGE_SIZE = 20;

const QUEUE_NAMES = {
  400: "Normal Draft", 420: "Ranked Solo/Duo", 430: "Normal Blind",
  440: "Ranked Flex", 450: "ARAM", 490: "Quickplay", 700: "Clash",
  720: "ARAM Clash", 830: "Co-op vs AI Intro", 840: "Co-op vs AI Beginner",
  850: "Co-op vs AI Intermediate", 900: "ARURF", 1020: "One for All",
  1700: "Arena", 1900: "URF",
};
const RANKED_QUEUE_NAMES = {
  RANKED_SOLO_5x5: "Ranked Solo/Duo",
  RANKED_FLEX_SR: "Ranked Flex",
};
const ROLE_LABELS = { TOP: "Top", JUNGLE: "Jungle", MIDDLE: "Mid", BOTTOM: "Bottom", UTILITY: "Support" };
const SORT_LABELS = {
  newest: "Newest first", oldest: "Oldest first",
  most_kills: "Most kills", most_deaths: "Most deaths", most_assists: "Most assists",
  highest_kda: "Highest KDA", most_cs: "Most CS", highest_cs_per_min: "Highest CS/min",
  most_damage: "Most damage", most_gold: "Most gold", highest_vision: "Highest vision score",
  fastest_win: "Shortest games", longest_match: "Longest games",
};
const PLATFORMS = [
  ["na1", "NA"], ["euw1", "EUW"], ["eun1", "EUNE"], ["kr", "KR"], ["jp1", "JP"],
  ["br1", "BR"], ["la1", "LAN"], ["la2", "LAS"], ["oc1", "OCE"], ["ru", "RU"],
  ["tr1", "TR"], ["ph2", "PH"], ["sg2", "SG"], ["th2", "TH"], ["tw2", "TW"], ["vn2", "VN"],
];

function esc(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------
const platformSelect = document.getElementById("platformSelect");
const nameInput = document.getElementById("riotName");
const tagInput = document.getElementById("riotTag");
const searchForm = document.getElementById("searchForm");
const statusEl = document.getElementById("status");
const resultEl = document.getElementById("result");
const identityEl = document.getElementById("identity");
const rankGridEl = document.getElementById("rankGrid");
const filtersEl = document.getElementById("filters");
const champFilter = document.getElementById("filterChampion");
const roleFilter = document.getElementById("filterRole");
const queueFilter = document.getElementById("filterQueue");
const winFilter = document.getElementById("filterWin");
const minKillsFilter = document.getElementById("filterMinKills");
const minCsFilter = document.getElementById("filterMinCs");
const sortSelect = document.getElementById("filterSort");
const matchCountEl = document.getElementById("matchCount");
const tableWrapEl = document.getElementById("tableWrap");
const tableBodyEl = document.getElementById("tableBody");
const loadMoreBtn = document.getElementById("loadMoreBtn");
const savedProfilesSection = document.getElementById("savedProfilesSection");
const savedListEl = document.getElementById("savedList");
const saveProfileBtn = document.getElementById("saveProfileBtn");

// Current search context — what's on screen right now, so filters/sort/
// pagination can re-query without re-resolving the account each time.
let current = null; // { platform, region, puuid, gameName, tagLine }
let nextStart = 0;

function setStatus(message, type) {
  if (!message) { clearStatus(); return; }
  statusEl.textContent = message;
  statusEl.className = `status-line show ${type || ""}`;
}
function clearStatus() {
  statusEl.className = "status-line";
  statusEl.textContent = "";
}
function showResult(show) {
  resultEl.className = show ? "lp-result show" : "lp-result";
}

function fmtDate(ms) {
  if (!ms) return "—";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}
function fmtDuration(sec) {
  if (!sec && sec !== 0) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function apiGet(path, params) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`${WORKER_BASE}${path}?${qs.toString()}`);
  let body;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const message = body?.error?.message || `Request failed (${res.status})`;
    const err = new Error(message);
    err.code = body?.error?.code;
    throw err;
  }
  return body;
}

// ---------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------
searchForm.addEventListener("submit", (e) => {
  e.preventDefault();
  runSearch();
});

async function runSearch() {
  const platform = platformSelect.value;
  const name = nameInput.value.trim();
  const tag = tagInput.value.trim().replace(/^#/, "");
  if (!name || !tag) {
    setStatus("Enter both a Riot ID name and tag line (e.g. Faker #KR1).", "error");
    return;
  }

  showResult(false);
  setStatus("Looking up Riot ID…");

  try {
    const account = await apiGet("/account", { platform, name, tag });
    current = { platform, region: account.region, puuid: account.puuid, gameName: account.gameName || name, tagLine: account.tagLine || tag };

    setStatus("Loading rank…");
    const rankData = await apiGet("/rank", { platform, puuid: current.puuid });
    renderIdentity();
    renderRank(rankData.rank || []);
    updateSaveButton();

    resetFiltersUI();
    clearStatus();
    showResult(true);
    await loadMatches(true);
  } catch (err) {
    setStatus(err.message || "Something went wrong.", "error");
  }
}

function renderIdentity() {
  identityEl.innerHTML = `
    <h2 class="lp-name">${esc(current.gameName)} <span class="tag">#${esc(current.tagLine)}</span></h2>
    <div class="lp-identity-actions">
      <button id="saveProfileBtnInner" class="btn btn-secondary btn-sm" type="button" hidden>+ Save Profile</button>
    </div>`;
  const inner = document.getElementById("saveProfileBtnInner");
  inner.addEventListener("click", saveCurrentProfile);
  saveProfileBtn.el = inner;
}

function renderRank(entries) {
  if (!entries.length) {
    rankGridEl.innerHTML = `<div class="lp-rank-empty">No ranked stats yet for this Summoner in Solo/Duo or Flex.</div>`;
    return;
  }
  rankGridEl.innerHTML = entries.map((e) => {
    const label = RANKED_QUEUE_NAMES[e.queueType] || e.queueType;
    const wins = e.wins || 0, losses = e.losses || 0;
    const total = wins + losses;
    const wr = total ? Math.round((wins / total) * 100) : 0;
    return `
      <div class="lp-rank-card">
        <div class="queue">${esc(label)}</div>
        <div class="tier">${esc(e.tier)} ${esc(e.rank)}</div>
        <div class="lp">${esc(e.leaguePoints)} LP</div>
        <div class="wl">${wins}W ${losses}L &middot; ${wr}% win rate</div>
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------------
// Filters + match table
// ---------------------------------------------------------------------
function resetFiltersUI() {
  champFilter.value = "";
  roleFilter.value = "";
  queueFilter.value = "";
  winFilter.value = "";
  minKillsFilter.value = "";
  minCsFilter.value = "";
  sortSelect.value = "newest";
}

[champFilter, roleFilter, queueFilter, winFilter, minKillsFilter, minCsFilter, sortSelect].forEach((el) => {
  el.addEventListener("change", () => loadMatches(true));
});
champFilter.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); loadMatches(true); } });

loadMoreBtn.addEventListener("click", () => loadMatches(false));

function currentFilterParams() {
  const params = { platform: current.platform, puuid: current.puuid, count: PAGE_SIZE, sort: sortSelect.value };
  if (champFilter.value.trim()) params.champion = champFilter.value.trim();
  if (roleFilter.value) params.role = roleFilter.value;
  if (queueFilter.value) params.queueId = queueFilter.value;
  if (winFilter.value) params.win = winFilter.value;
  if (minKillsFilter.value) params.minKills = minKillsFilter.value;
  if (minCsFilter.value) params.minCs = minCsFilter.value;
  return params;
}

async function loadMatches(reset) {
  if (!current) return;
  if (reset) {
    nextStart = 0;
    tableBodyEl.innerHTML = "";
  }
  loadMoreBtn.disabled = true;
  loadMoreBtn.textContent = "Loading…";
  try {
    const data = await apiGet("/matches", { ...currentFilterParams(), start: nextStart });
    if (reset) {
      matchCountEl.textContent = `${data.total} match${data.total === 1 ? "" : "es"} found`;
    }
    renderMatchRows(data.items || [], reset);
    nextStart = data.nextStart;
    loadMoreBtn.hidden = nextStart === null || nextStart === undefined;
    loadMoreBtn.disabled = false;
    loadMoreBtn.textContent = "Load More";
  } catch (err) {
    setStatus(err.message || "Could not load matches.", "error");
    loadMoreBtn.hidden = true;
  }
}

function renderMatchRows(items, reset) {
  if (reset && items.length === 0) {
    tableWrapEl.hidden = true;
    tableBodyEl.innerHTML = `<div class="lp-empty">No matches match the current filters.</div>`;
    return;
  }
  tableWrapEl.hidden = false;
  const rowsHtml = items.map((m) => {
    const resultClass = m.win ? "win" : "loss";
    const resultText = m.win ? "Win" : "Loss";
    const resultCellClass = m.win ? "result-win" : "result-loss";
    const queueLabel = QUEUE_NAMES[m.queue_id] || `Queue ${m.queue_id}`;
    const roleLabel = ROLE_LABELS[m.role] || m.role || "—";
    return `
      <tr class="${resultClass}">
        <td class="${resultCellClass}">${resultText}</td>
        <td>${fmtDate(m.game_start_ms)}</td>
        <td>${esc(queueLabel)}</td>
        <td class="champ">${esc(m.champion)}</td>
        <td>${esc(roleLabel)}</td>
        <td>${m.kills} / ${m.deaths} / ${m.assists}</td>
        <td>${esc(m.kda)}</td>
        <td>${esc(m.cs)} (${esc(m.cs_per_min ?? "—")}/m)</td>
        <td>${esc(m.damage_to_champs)}</td>
        <td>${esc(m.gold)}</td>
        <td>${esc(m.vision_score)}</td>
        <td>${fmtDuration(m.duration_sec)}</td>
        <td><button type="button" class="btn btn-secondary btn-sm" data-ai-review-btn data-match-id="${esc(m.match_id)}">AI Review</button></td>
      </tr>`;
  }).join("");
  if (reset) {
    tableBodyEl.innerHTML = rowsHtml;
  } else {
    tableBodyEl.insertAdjacentHTML("beforeend", rowsHtml);
  }
}

// ---------------------------------------------------------------------
// AI match review (Plus/Premier feature — requires sign-in and an
// available allowance; see lol/billing-shared.js and
// workers/zindigon-league-api/src/index.js's POST /ai/review + /ai/followup).
// Free-plan users can still click the button; the Worker's own allowance
// check is what actually gates access (nothing is hidden client-side).
// ---------------------------------------------------------------------
tableBodyEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-ai-review-btn]");
  if (!btn || !current) return;

  if (typeof LeagueAuth === "undefined" || !LeagueAuth.isSignedIn()) {
    alert("Sign in to get an AI review of this match.");
    return;
  }

  const matchId = btn.dataset.matchId;
  const originalText = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Reviewing…";
  try {
    const result = await requestAiReview({ matchId, platform: current.platform, puuid: current.puuid });
    showAiReviewPanel(matchId, result.review);
  } catch (err) {
    if (err.code === "allowance_exceeded") {
      showAiReviewError(`${esc(err.message)} <a href="pricing.html">See Plus/Premier plans</a>.`);
    } else if (err.code === "unauthorized") {
      alert("Please sign in again to get an AI review.");
    } else {
      alert(err.message || "Could not generate a review right now.");
    }
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

function showAiReviewError(html) {
  const panel = document.getElementById("aiReviewPanel");
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `<div class="lp-ai-review-error">${html}</div>`;
}

function showAiReviewPanel(matchId, reviewText) {
  const panel = document.getElementById("aiReviewPanel");
  if (!panel) return;
  panel.hidden = false;
  panel.innerHTML = `
    <div class="lp-ai-review-header">
      <h3>AI Match Review</h3>
      <button type="button" class="lp-ai-review-close" aria-label="Close">&times;</button>
    </div>
    <p class="lp-ai-review-body">${esc(reviewText).replace(/\n/g, "<br>")}</p>
    <form class="lp-ai-followup-form" data-match-id="${esc(matchId)}">
      <input type="text" class="input" placeholder="Ask a follow-up question…" required />
      <button type="submit" class="btn btn-secondary btn-sm">Ask</button>
    </form>
    <div class="lp-ai-followup-answer"></div>`;

  panel.querySelector(".lp-ai-review-close").addEventListener("click", () => { panel.hidden = true; });
  panel.querySelector(".lp-ai-followup-form").addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const form = evt.target;
    const input = form.querySelector("input");
    const question = input.value.trim();
    if (!question) return;
    const answerEl = panel.querySelector(".lp-ai-followup-answer");
    const submitBtn = form.querySelector("button[type=submit]");
    submitBtn.disabled = true;
    answerEl.textContent = "Thinking…";
    try {
      const result = await requestAiFollowup({ matchId: form.dataset.matchId, question });
      answerEl.textContent = result.answer;
      input.value = "";
    } catch (err) {
      answerEl.textContent = err.message || "Could not answer that right now.";
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------
// Checkout return handling (from Stripe, via pricing.html -> Checkout ->
// back here). This NEVER grants access itself — the server-side webhook
// (already verified by the time Stripe redirects back) is the only thing
// that does that. This just shows feedback and re-reads the real status.
// ---------------------------------------------------------------------
function handleCheckoutReturn() {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get("checkout");
  if (checkout === "success") {
    setStatus("Finishing up your subscription… this can take a few seconds.", "warn");
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      try { if (typeof refreshPlanBadge === "function") await refreshPlanBadge(); } catch { /* keep polling */ }
      if (attempts >= 5) { clearInterval(poll); clearStatus(); }
    }, 2000);
  } else if (checkout === "cancel") {
    setStatus("Checkout canceled — no changes were made.", "warn");
  } else {
    return;
  }
  params.delete("checkout");
  params.delete("session_id");
  const clean = window.location.pathname + (params.toString() ? `?${params}` : "");
  window.history.replaceState({}, "", clean);
}

// ---------------------------------------------------------------------
// Saved profiles (requires sign-in — see lol/auth-shared.js)
// ---------------------------------------------------------------------
async function refreshSavedProfiles() {
  if (typeof LeagueAuth === "undefined" || !LeagueAuth.isSignedIn()) {
    savedProfilesSection.hidden = true;
    return;
  }
  savedProfilesSection.hidden = false;
  const profiles = await listSavedProfiles();
  if (!profiles.length) {
    savedListEl.innerHTML = `<span class="lp-saved-empty">No saved profiles yet — search for a Summoner and save it below.</span>`;
    return;
  }
  savedListEl.innerHTML = profiles.map((p) => `
    <span class="lp-saved-chip" data-id="${esc(p.id)}" data-platform="${esc(p.platform)}" data-name="${esc(p.game_name)}" data-tag="${esc(p.tag_line)}">
      ${esc(p.game_name)}#${esc(p.tag_line)} <span class="mono">(${esc(p.platform)})</span>
      <button type="button" data-remove="${esc(p.id)}" title="Remove">&times;</button>
    </span>`).join("");
  savedListEl.querySelectorAll(".lp-saved-chip").forEach((chip) => {
    chip.addEventListener("click", (e) => {
      if (e.target.closest("[data-remove]")) return;
      platformSelect.value = chip.dataset.platform;
      nameInput.value = chip.dataset.name;
      tagInput.value = chip.dataset.tag;
      runSearch();
    });
  });
  savedListEl.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await deleteSavedProfile(btn.dataset.remove);
        await refreshSavedProfiles();
      } catch (err) {
        alert("Could not remove saved profile: " + err.message);
      }
    });
  });
}

function updateSaveButton() {
  const inner = saveProfileBtn.el;
  if (!inner) return;
  const signedIn = typeof LeagueAuth !== "undefined" && LeagueAuth.isSignedIn() && LeagueAuth.hasProfile();
  inner.hidden = !signedIn;
}

async function saveCurrentProfile() {
  if (!current) return;
  try {
    await saveRiotProfile({
      platform: current.platform,
      region: current.region,
      gameName: current.gameName,
      tagLine: current.tagLine,
      puuid: current.puuid,
      relationship: "me",
    });
    await refreshSavedProfiles();
  } catch (err) {
    alert(err.message || "Could not save this profile.");
  }
}

// Called by account.js after sign in/out/profile creation.
function onAccountChange() {
  refreshSavedProfiles();
  updateSaveButton();
}

document.addEventListener("DOMContentLoaded", () => {
  refreshSavedProfiles();
  handleCheckoutReturn();
});
