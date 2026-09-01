// Zindigon ToonData | Census API client
// Docs: https://census.daybreakgames.com/

// swap for the approved service ID once Daybreak confirms it
const SERVICE_ID = "s:example";
const CENSUS_BASE = "https://census.daybreakgames.com";
const NAMESPACE = "dcuo:v1";
const PAGE_SIZE = 500;   // Census times out on much larger c:limit values for feat collections
const MAX_PAGES = 20;    // safety cap: 20 * 500 = 10,000 rows
const MAX_RETRIES = 3;
const ROSTER_LIMIT = 500;      // safety cap on how many members a single league roster fetch returns
const CHAR_BATCH_SIZE = 40;    // how many character_ids get resolved to names per batched request
const VIEW_CACHE_TTL_MS = 5 * 60 * 1000; // how long a character/roster view is reused on Back before refetching

// Census doesn't provide a name lookup for these IDs, so this is a small
// hand-maintained table of the ones that are known. Anything not listed
// here just falls back to showing the raw ID. Add to these as more get
// confirmed.
const POWER_TYPE_NAMES = {
  "1992462": "Rage",
  "2784": "Earth",
  "2325": "Electricity",
  "1810455": "Quantum",
  "74779": "Nature",
  "3050978": "Water",
};
const MOVEMENT_MODE_NAMES = {
  "3317": "Super Speed",
  // 3313 covers both Flight and Skimming — Census exposes the same ID for
  // both, so there's no way to tell them apart from this field alone.
  "3313": "Flight / Skimming",
};
const WORLD_NAMES = {
  "2": "US/PS/PC",
};
// Confirmed by cross-checking gender_id against character names strongly
// associated with one gender (Batman/Superman-themed vs. Wonder
// Woman/Supergirl-themed) — same method used for alignment_id.
const GENDER_NAMES = {
  "0": "Male",
  "1": "Female",
};
// alignment_id isn't documented by Daybreak, but it only ever takes two
// values and cross-checking name patterns (Batman/Superman-themed names
// vs. Joker/Harley Quinn-themed names) confirms which is which.
const ALIGNMENT_NAMES = { "2330": "Hero", "2331": "Villain" };

// ---------------------------------------------------------------------
// Low-level Census fetch with retry/backoff on 429 / transient errors
// ---------------------------------------------------------------------
async function censusGet(collection, params) {
  const qs = new URLSearchParams(params);
  const url = `${CENSUS_BASE}/${SERVICE_ID}/get/${NAMESPACE}/${collection}?${qs.toString()}`;

  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);

      if (res.status === 429) {
        throw new RateLimitError();
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from Census for ${collection}`);
      }

      const json = await res.json();

      if (json.error === "login_required") {
        throw new AuthWallError(collection);
      }
      if (json.errorCode) {
        throw new Error(`Census error on ${collection}: ${json.errorCode} - ${json.errorMessage || ""}`);
      }

      return json;
    } catch (err) {
      if (err instanceof AuthWallError) throw err;
      lastErr = err;
      if (err instanceof RateLimitError && attempt === MAX_RETRIES - 1) throw err;
      const waitMs = 1200 * Math.pow(2, attempt);
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

class RateLimitError extends Error {
  constructor() { super("Too many searches right now. Please wait a minute and try again."); }
}
class AuthWallError extends Error {
  constructor(collection) { super(`That information requires the player to be logged in and isn't available here.`); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchAllPages(collection, baseParams) {
  const all = [];
  const listKey = `${collection}_list`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const json = await censusGet(collection, {
      ...baseParams,
      "c:limit": PAGE_SIZE,
      "c:start": page * PAGE_SIZE,
    });
    const items = json[listKey] || [];
    all.push(...items);
    if (items.length < PAGE_SIZE) break;
  }
  return all;
}

// ---------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------
const statusEl = document.getElementById("status");
const matchListEl = document.getElementById("matchList");
const resultEl = document.getElementById("result");
const searchBtn = document.getElementById("searchBtn");
const nameInput = document.getElementById("charName");
const leagueSearchBtn = document.getElementById("leagueSearchBtn");
const leagueNameInput = document.getElementById("leagueName");
const modeCharBtn = document.getElementById("modeCharBtn");
const modeLeagueBtn = document.getElementById("modeLeagueBtn");
const charSearchForm = document.getElementById("charSearchForm");
const leagueSearchForm = document.getElementById("leagueSearchForm");
const pageTitleEl = document.getElementById("pageTitle");
const pageLedeEl = document.getElementById("pageLede");

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status-line show ${type || ""}`;
}
function clearStatus() {
  statusEl.className = "status-line";
  statusEl.textContent = "";
}
function clearMatches() {
  matchListEl.innerHTML = "";
}
function clearResult() {
  resultEl.className = "td-result";
  resultEl.innerHTML = "";
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

// Formats a stat number with comma separators. Some characters are
// genuinely missing fields Census would normally compute (seen directly on
// a real low-level toon with no combat_rating at all), so this falls back
// to an em dash instead of printing "NaN".
function fmt(n) {
  if (n === undefined || n === null || n === "") return "—";
  const num = Number(n);
  return Number.isNaN(num) ? "—" : num.toLocaleString();
}

// ---------------------------------------------------------------------
// Mode toggle (Character search vs. League search)
// ---------------------------------------------------------------------
function setMode(mode) {
  const isChar = mode === "character";
  charSearchForm.style.display = isChar ? "" : "none";
  leagueSearchForm.style.display = isChar ? "none" : "";
  modeCharBtn.classList.toggle("active", isChar);
  modeCharBtn.setAttribute("aria-selected", String(isChar));
  modeLeagueBtn.classList.toggle("active", !isChar);
  modeLeagueBtn.setAttribute("aria-selected", String(!isChar));

  if (isChar) {
    pageTitleEl.textContent = "Character Lookup";
    pageLedeEl.textContent = "Look up your DC Universe Online character's stats, gear, and feats.";
  } else {
    pageTitleEl.textContent = "League Lookup";
    pageLedeEl.textContent = "Look up a DC Universe Online league's roster and members.";
  }
}
modeCharBtn.addEventListener("click", () => setMode("character"));
modeLeagueBtn.addEventListener("click", () => setMode("league"));

// ---------------------------------------------------------------------
// View cache + history — lets the browser Back/Forward buttons return to
// a character or league view without re-hitting Census, as long as that
// view was loaded within the last few minutes (VIEW_CACHE_TTL_MS). Older
// than that, it refetches, in case the underlying data changed since.
//
// Every character or roster view gets its own URL fragment
// (#char/<id> or #league/<id>) via history.pushState, so Back is a real
// browser navigation rather than just an in-page state change — without
// that, there'd be nothing for Back to actually go back *to*.
// ---------------------------------------------------------------------
// The cache stores the underlying DATA for a view (not rendered HTML) and
// applyView re-runs the real render function against it. Caching a raw
// HTML string and reinjecting it via innerHTML was tried first, but that
// produces brand-new DOM nodes with no event listeners attached — so any
// interactive part of the view (sortable roster headers, clicking through
// to a member's profile) went permanently dead the moment a cached view
// was restored. Re-rendering from data keeps every listener live.
const viewCache = new Map(); // viewKey -> { data, fetchedAt }

function cacheView(key, data) {
  viewCache.set(key, { data, fetchedAt: Date.now() });
}
function getFreshView(key) {
  const entry = viewCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > VIEW_CACHE_TTL_MS) return null;
  return entry.data;
}
function applyView(data) {
  clearStatus();
  clearMatches();
  if (data.type === "character") {
    renderCharacter(data.character, data.equippedItems, data.completedFeats, data.activeFeats, data.league);
  } else if (data.type === "league") {
    renderRoster(data.guildId, data.guildName, data.members, data.byId, data.sortState);
  }
}
function pushView(hash) {
  if (location.hash !== hash) {
    history.pushState({ tdView: true }, "", hash);
  }
}

window.addEventListener("popstate", () => {
  handleHash(location.hash, { skipPush: true });
});

function handleHash(hash, opts) {
  const charMatch = hash.match(/^#char\/(\d+)$/);
  const leagueMatch = hash.match(/^#league\/([^/?#]+)$/);
  if (charMatch) {
    loadCharacterById(charMatch[1], opts);
  } else if (leagueMatch) {
    loadLeagueRoster(leagueMatch[1], null, opts);
  }
  // Anything else (empty hash, or Back past the first result) — nothing
  // to load, just leave whatever's already on screen.
}

// ---------------------------------------------------------------------
// Character search flow
// ---------------------------------------------------------------------
async function runSearch(name, worldId) {
  clearStatus();
  clearMatches();
  clearResult();
  setStatus("Looking up character...");
  searchBtn.disabled = true;

  try {
    const charParams = { name };
    if (worldId) charParams.world_id = worldId;

    const charJson = await censusGet("character", charParams);
    const matches = charJson.character_list || [];

    if (matches.length === 0) {
      setStatus(`No character named "${name}" was found.`, "error");
      return;
    }

    if (matches.length > 1) {
      setStatus(`More than one character is named "${name}". Pick the right one:`, "warn");
      matchListEl.innerHTML = matches.map(m => `
        <div class="td-match-item" data-character-id="${esc(m.character_id)}" data-world-id="${esc(m.world_id)}">
          <span>${esc(m.name)}, Level ${esc(m.level)}</span>
          <span>Combat Rating ${esc(m.combat_rating)}</span>
        </div>
      `).join("");
      [...matchListEl.children].forEach(el => {
        el.addEventListener("click", () => {
          runSearch(name, el.dataset.worldId);
        });
      });
      return;
    }

    await showCharacter(matches[0]);

  } catch (err) {
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  } finally {
    searchBtn.disabled = false;
  }
}

// Renders a character we already have the full Census object for (from a
// name search). Pushes its own #char/<id> history entry and caches the
// rendered result so Back/Forward can reuse it — see the view cache block
// above. opts.skipPush is set when this is being restored by popstate,
// since the URL already reflects this view in that case.
async function showCharacter(character, opts) {
  opts = opts || {};
  const characterId = character.character_id;
  const cacheKey = `char:${characterId}`;
  if (!opts.skipPush) pushView(`#char/${characterId}`);

  const cached = getFreshView(cacheKey);
  if (cached) {
    applyView(cached);
    return;
  }

  clearMatches();
  setStatus("Fetching gear...");
  try {
    const itemsJson = await censusGet("characters_item", { character_id: characterId, "c:limit": 500 });
    const equippedItems = (itemsJson.characters_item_list || [])
      .sort((a, b) => Number(a.equipment_slot_id) - Number(b.equipment_slot_id));

    setStatus("Fetching feats...");
    const completedFeats = await fetchAllPages("characters_completed_feat", { character_id: characterId });
    const activeFeats = await fetchAllPages("characters_active_feat", { character_id: characterId });

    setStatus("Fetching league...");
    let league = null;
    try {
      const rosterJson = await censusGet("guild_roster", { character_id: characterId });
      const membership = (rosterJson.guild_roster_list || [])[0];
      if (membership) {
        const guildJson = await censusGet("guild", { guild_id: membership.guild_id });
        const guildInfo = (guildJson.guild_list || [])[0];
        league = { guild_id: membership.guild_id, rank: membership.rank, name: guildInfo ? guildInfo.name : null };
      }
    } catch (e) {
      league = null;
    }

    clearStatus();
    renderCharacter(character, equippedItems, completedFeats, activeFeats, league);
    cacheView(cacheKey, { type: "character", character, equippedItems, completedFeats, activeFeats, league });

  } catch (err) {
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  }
}

// Renders a character we only have the character_id for (a league roster
// row). Looks the character up by ID first, then hands off to
// showCharacter for the rest — same caching/history behavior either way.
async function loadCharacterById(characterId, opts) {
  opts = opts || {};
  const cacheKey = `char:${characterId}`;
  if (!opts.skipPush) pushView(`#char/${characterId}`);

  const cached = getFreshView(cacheKey);
  if (cached) {
    applyView(cached);
    return;
  }

  clearStatus();
  clearMatches();
  clearResult();
  setStatus("Loading character...");
  try {
    const charJson = await censusGet("character", { character_id: characterId });
    const character = (charJson.character_list || [])[0];
    if (!character) {
      setStatus("That character couldn't be loaded — they may have transferred, been renamed, or been deleted.", "error");
      return;
    }
    await showCharacter(character, { skipPush: true });
  } catch (err) {
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  }
}

// ---------------------------------------------------------------------
// League search flow
// ---------------------------------------------------------------------
async function runLeagueSearch(name) {
  clearStatus();
  clearMatches();
  clearResult();
  setStatus("Looking up league...");
  leagueSearchBtn.disabled = true;

  try {
    const guildJson = await censusGet("guild", { name: `^${name}`, "c:limit": 20 });
    const matches = guildJson.guild_list || [];

    if (matches.length === 0) {
      setStatus(`No league named "${name}" was found.`, "error");
      return;
    }

    if (matches.length > 1) {
      setStatus(`More than one league matches "${name}". Pick the right one:`, "warn");
      matchListEl.innerHTML = matches.map(m => `
        <div class="td-match-item" data-guild-id="${esc(m.guild_id)}" data-guild-name="${esc(m.name)}">
          <span>${esc(m.name)}</span>
          <span>${esc(WORLD_NAMES[m.world_id] || `World #${m.world_id}`)}</span>
        </div>
      `).join("");
      [...matchListEl.children].forEach(el => {
        el.addEventListener("click", () => {
          loadLeagueRoster(el.dataset.guildId, el.dataset.guildName);
        });
      });
      return;
    }

    await loadLeagueRoster(matches[0].guild_id, matches[0].name);

  } catch (err) {
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  } finally {
    leagueSearchBtn.disabled = false;
  }
}

// Loads a full league roster by guild_id and renders it as a clickable
// member table. Pushes its own #league/<id> history entry and caches the
// rendered result, same pattern as showCharacter above — so clicking into
// a member's profile and hitting Back returns here instantly if it's
// still within the cache window, instead of re-fetching the whole roster.
async function loadLeagueRoster(guildId, knownName, opts) {
  opts = opts || {};
  const cacheKey = `league:${guildId}`;
  if (!opts.skipPush) pushView(`#league/${guildId}`);

  const cached = getFreshView(cacheKey);
  if (cached) {
    applyView(cached);
    return;
  }

  clearStatus();
  clearMatches();
  clearResult();
  setStatus("Loading roster...");
  try {
    const rosterJson = await censusGet("guild_roster", { guild_id: guildId, "c:limit": ROSTER_LIMIT });
    const members = rosterJson.guild_roster_list || [];

    if (members.length === 0) {
      setStatus("That league has no members, or couldn't be loaded.", "error");
      return;
    }

    let guildName = knownName;
    let guildInfo = null;
    if (!guildName) {
      const guildJson = await censusGet("guild", { guild_id: guildId });
      guildInfo = (guildJson.guild_list || [])[0];
      guildName = guildInfo ? guildInfo.name : "League";
    }

    setStatus(`Loading ${members.length} member${members.length === 1 ? "" : "s"}...`);
    // Resolve character_id -> name/level/CR in batches. A batch failing
    // (rate limit, etc.) shouldn't take down the whole roster — those
    // members just fall back to showing their raw ID below.
    const byId = {};
    for (let i = 0; i < members.length; i += CHAR_BATCH_SIZE) {
      const batch = members.slice(i, i + CHAR_BATCH_SIZE);
      const idsParam = batch.map(m => m.character_id).join(",");
      try {
        const charJson = await censusGet("character", { character_id: idsParam, "c:limit": CHAR_BATCH_SIZE });
        (charJson.character_list || []).forEach(c => { byId[c.character_id] = c; });
      } catch (e) {
        // leave this batch unresolved rather than aborting the roster
      }
    }

    clearStatus();
    renderRoster(guildId, guildName, members, byId);

  } catch (err) {
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  }
}

// Roster columns that can be sorted client-side (no re-fetch needed — the
// full member list and their resolved character records are already in
// hand). "name" sorts alphabetically; "cr" and "sp" sort numerically, with
// unresolved members (no matching character record) treated as lowest so
// they sink to the bottom instead of interrupting the ranking.
const ROSTER_SORT_KEYS = { name: true, cr: true, sp: true };

function renderRoster(guildId, guildName, members, byId, resumeSort) {
  // dir: 1 = ascending, -1 = descending. resumeSort carries the sort the
  // user had chosen when this same roster was last rendered (Back, or
  // searching the same league again within the cache window), so it isn't
  // silently reset to fetch order.
  const sortState = resumeSort ? { ...resumeSort } : { key: null, dir: 1 };

  function sortValue(key, m) {
    const c = byId[m.character_id];
    if (key === "name") return (c ? c.name : `Character #${m.character_id}`).toLowerCase();
    if (key === "cr") return c && c.combat_rating !== undefined && c.combat_rating !== null ? Number(c.combat_rating) : -1;
    if (key === "sp") return c && c.skill_points !== undefined && c.skill_points !== null ? Number(c.skill_points) : -1;
    return 0;
  }

  function sortedMembers() {
    if (!sortState.key) return members;
    return [...members].sort((a, b) => {
      const va = sortValue(sortState.key, a);
      const vb = sortValue(sortState.key, b);
      if (va < vb) return -1 * sortState.dir;
      if (va > vb) return 1 * sortState.dir;
      return 0;
    });
  }

  function buildRowsHtml(list) {
    return list.map(m => {
      const c = byId[m.character_id];
      const name = c ? esc(c.name) : `Character #${esc(m.character_id)}`;
      const level = c ? fmt(c.level) : "—";
      const cr = c ? fmt(c.combat_rating) : "—";
      const sp = c ? fmt(c.skill_points) : "—";
      return `<tr class="td-roster-row" data-character-id="${esc(m.character_id)}" tabindex="0">
        <td>${name}</td>
        <td>${level}</td>
        <td>${cr}</td>
        <td>${sp}</td>
        <td>${esc(m.rank)}</td>
      </tr>`;
    }).join("");
  }

  function attachRowHandlers() {
    resultEl.querySelectorAll(".td-roster-row").forEach(row => {
      const go = () => loadCharacterById(row.dataset.characterId);
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    });
  }

  function updateHeaderIndicators() {
    resultEl.querySelectorAll(".td-roster-table th[data-sort-key]").forEach(th => {
      th.classList.remove("sorted-asc", "sorted-desc");
      if (th.dataset.sortKey === sortState.key) {
        th.classList.add(sortState.dir === 1 ? "sorted-asc" : "sorted-desc");
      }
    });
  }

  // Caches the data behind this exact roster view, including whatever sort
  // is currently active, so a later Back or repeat search re-renders (with
  // listeners intact — see the view cache block above) in the same order
  // instead of resetting to fetch order.
  function cacheCurrent() {
    cacheView(`league:${guildId}`, { type: "league", guildId, guildName, members, byId, sortState: { ...sortState } });
  }

  function renderTbody() {
    const tbody = resultEl.querySelector(".td-roster-table tbody");
    tbody.innerHTML = buildRowsHtml(sortedMembers());
    attachRowHandlers();
    updateHeaderIndicators();
    cacheCurrent();
  }

  resultEl.innerHTML = `
    <div class="td-roster">
      <p class="td-section-label">League — ${esc(guildName)} (${members.length} member${members.length === 1 ? "" : "s"})</p>
      <table class="td-roster-table">
        <thead><tr>
          <th class="sortable" data-sort-key="name">Name</th>
          <th>Level</th>
          <th class="sortable" data-sort-key="cr">Combat Rating</th>
          <th class="sortable" data-sort-key="sp">Skill Points</th>
          <th>Rank</th>
        </tr></thead>
        <tbody>${buildRowsHtml(sortedMembers())}</tbody>
      </table>
      <p class="td-roster-note">Click a member to see their full profile. Click Name, Combat Rating, or Skill Points to sort — click again to reverse. Rank is shown as the game's raw rank number — Census doesn't provide rank names like Leader or Officer. A roster reflects Census data at the moment it loaded; search again to refresh it.</p>
    </div>
  `;
  resultEl.className = "td-result show";
  attachRowHandlers();
  updateHeaderIndicators();
  cacheCurrent();

  resultEl.querySelectorAll(".td-roster-table th[data-sort-key]").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sortKey;
      if (!ROSTER_SORT_KEYS[key]) return;
      if (sortState.key === key) {
        sortState.dir *= -1;
      } else {
        sortState.key = key;
        // Name defaults to A-Z; the numeric columns default to highest
        // first, since that's the order people usually want to rank a
        // roster by combat rating or skill points.
        sortState.dir = key === "name" ? 1 : -1;
      }
      renderTbody();
    });
  });
}

// ---------------------------------------------------------------------
// Character render
// ---------------------------------------------------------------------
function renderCharacter(c, items, completedFeats, activeFeats, league) {
  const kv = (label, value) => `<div><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div></div>`;
  const row = (label, value) => `<div class="td-row"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;

  const itemRows = items.map(it => `
    <tr>
      <td>${esc(it.equipment_slot_id)}</td>
      <td>${esc(it.item_id)}</td>
      <td>${it.is_bound === "true" ? "Yes" : "No"}</td>
      <td>${[it.aug_item_id_1, it.aug_item_id_2, it.aug_item_id_3].filter(v => v && v !== "-1").join(", ") || "None"}</td>
    </tr>
  `).join("");

  // Paperdoll — slot 0-7 flank the left, 8-14 flank the right, fixed at
  // that size so the two columns stay a predictable height next to the
  // silhouette instead of stretching it. Which slot is which body part
  // isn't mapped yet, so this is just even spacing for now, not
  // anatomically placed.
  //
  // Not every equipped item lives in that 0-14 range — weapon/offhand/
  // trinket/artifact/stat-mod slots (24-27, per what's been confirmed so
  // far) use higher slot IDs that aren't mapped yet. Those still show up
  // in the "All equipped items" table below. Rather than appending them
  // to the flanking columns (which is what made the paperdoll balloon and
  // stretch when a character had gear in those slots), they get their own
  // small expandable list right under the paperdoll — collapsed by
  // default, same pattern as the equipped-items table — so nothing is
  // silently missing from view without the fixed layout blowing up.
  const bySlot = {};
  items.forEach(it => { bySlot[it.equipment_slot_id] = it; });
  const KNOWN_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
  const slotChip = (slotId) => {
    const it = bySlot[slotId];
    return `<div class="td-slot-chip">
      <span class="n">Slot ${slotId}</span>
      <span class="v${it ? "" : " empty"}">${it ? esc(it.item_id) : "Empty"}</span>
    </div>`;
  };
  const leftSlots = [0, 1, 2, 3, 4, 5, 6, 7].map(slotChip).join("");
  const rightSlots = [8, 9, 10, 11, 12, 13, 14].map(slotChip).join("");

  const extraSlotIds = Object.keys(bySlot)
    .map(Number)
    .filter(n => !KNOWN_SLOTS.includes(n))
    .sort((a, b) => a - b);
  const extraSlotsHtml = extraSlotIds.map(slotChip).join("");

  const featIdSpans = (list) => list.map(f => `<span>#${esc(f.feat_id)}</span>`).join("");

  const roleLabel = ALIGNMENT_NAMES[c.alignment_id] || null;

  const leagueName = league && league.name ? esc(league.name) : "None";
  const leagueLink = league && league.guild_id
    ? `<a href="#league/${esc(league.guild_id)}" class="td-league-link" data-guild-id="${esc(league.guild_id)}" data-guild-name="${leagueName}">${leagueName}</a>`
    : leagueName;

  // Simple stroke icons matching the site's brand-mark style. Power source
  // still has no known name lookup, so it's shown as a raw ID further down.
  const powerIcon = `<svg viewBox="0 0 16 16"><path d="M9 1 L3 9 L7 9 L6 15 L13 6 L9 6 Z"/></svg>`;
  const moveIcon = `<svg viewBox="0 0 16 16"><path d="M2 11 L7 6 M5 13 L10 8 M8 15 L13 10"/></svg>`;
  const powerTypeLabel = POWER_TYPE_NAMES[c.power_type_id] || `#${c.power_type_id}`;
  const movementLabel = MOVEMENT_MODE_NAMES[c.movement_mode_id] || `#${c.movement_mode_id}`;
  const worldLabel = WORLD_NAMES[c.world_id] || `#${c.world_id}`;

  resultEl.innerHTML = `
    <div class="td-identity">
      <div>
        <div class="td-name">${esc(c.name)}</div>
        <div class="td-identity-tags">
          ${roleLabel ? `<span class="td-tag td-role-tag">${esc(roleLabel)}</span>` : ""}
          <span class="td-tag">League <strong>${leagueLink}</strong></span>
          <span class="td-tag" title="World ID ${esc(c.world_id)}">Server <strong>${esc(worldLabel)}</strong></span>
        </div>
      </div>
      <div class="td-identity-icons">
        <span class="td-icon-chip" title="Power type (ID ${esc(c.power_type_id)})">${powerIcon}<span>${esc(powerTypeLabel)}</span></span>
        <span class="td-icon-chip" title="Movement mode (ID ${esc(c.movement_mode_id)})">${moveIcon}<span>${esc(movementLabel)}</span></span>
      </div>
    </div>

    <div class="td-columns">
      <div>
        <p class="td-section-label">Gear</p>
        <div class="td-paperdoll">
          <div class="td-paperdoll-slots">${leftSlots}</div>
          <div class="td-paperdoll-figure">
            <img src="paperdoll-silhouette.png" alt="" />
          </div>
          <div class="td-paperdoll-slots">${rightSlots}</div>
        </div>

        ${extraSlotIds.length ? `
        <details class="td-extra-slots">
          <summary class="td-section-label">More equipped slots (${extraSlotIds.length})</summary>
          <div class="td-extra-slots-grid">${extraSlotsHtml}</div>
        </details>
        ` : ""}

        <details class="td-gear-details">
          <summary class="td-section-label">All equipped items (${items.length})</summary>
          <table class="td-gear-table">
            <thead><tr><th>Slot</th><th>Item ID</th><th>Bound</th><th>Mods</th></tr></thead>
            <tbody>${itemRows}</tbody>
          </table>
        </details>
      </div>

      <div>
        <div class="td-hero-stats">
          <div class="td-hero-stat">
            <div class="v">${fmt(c.combat_rating)}</div>
            <div class="k">Combat Rating</div>
          </div>
          <div class="td-hero-stat">
            <div class="v">${fmt(c.skill_points)}</div>
            <div class="k">Skill Points</div>
          </div>
        </div>

        <div class="td-secondary-stats">
          <div><div class="k">Level</div><div class="v td-level">${fmt(c.level)}</div></div>
          <div><div class="k">PvP Combat Rating</div><div class="v td-pvp">${fmt(c.pvp_combat_rating)}</div></div>
        </div>

        <div class="td-rows">
          ${row("Health", fmt(c.max_health))}
          ${row("Power", fmt(c.max_power))}
          ${row("Might", fmt(c.might))}
          ${row("Precision", fmt(c.precision))}
          ${row("Restoration", fmt(c.restoration))}
          ${row("Vitalization", fmt(c.vitalization))}
          ${row("Dominance", fmt(c.dominance))}
          ${row("Defense", fmt(c.defense))}
          ${row("Toughness", fmt(c.toughness))}
        </div>

        <div class="td-kv">
          ${kv("Power Source", c.power_source_id)}
          ${kv("Gender", GENDER_NAMES[c.gender_id] || c.gender_id)}
          ${kv("Origin", c.origin_id)}
          ${kv("Title", c.title_id)}
          ${kv("Personality", c.personality_id)}
          ${kv("Region", c.region_id)}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:32px;">
      <p class="td-section-label">Feats</p>
      <div class="td-feat-summary">
        <div class="kv-single"><div class="k">Completed</div><div class="v">${completedFeats.length}</div></div>
        <div class="kv-single"><div class="k">In Progress</div><div class="v">${activeFeats.length}</div></div>
      </div>
      <details>
        <summary>Show completed feat IDs (${completedFeats.length})</summary>
        <div class="td-feat-ids">${featIdSpans(completedFeats)}</div>
      </details>
      <details style="margin-top:10px;">
        <summary>Show in-progress feat IDs (${activeFeats.length})</summary>
        <div class="td-feat-ids">${featIdSpans(activeFeats)}</div>
      </details>
    </div>

    <div class="card" style="margin-top:20px;">
      <p class="td-section-label">About this data</p>
      <ul class="td-limitations">
        <li>Feat IDs are shown raw. The Census API doesn't provide feat names.</li>
        <li>In-progress feats show only that they've been started, not how close they are to completion.</li>
        <li>Completed feats don't have a completion date attached.</li>
      </ul>
    </div>
  `;
  resultEl.className = "td-result show";

  const leagueLinkEl = resultEl.querySelector(".td-league-link");
  if (leagueLinkEl) {
    leagueLinkEl.addEventListener("click", (e) => {
      e.preventDefault();
      loadLeagueRoster(leagueLinkEl.dataset.guildId, leagueLinkEl.dataset.guildName);
    });
  }
}

// ---------------------------------------------------------------------
// Wire up UI
// ---------------------------------------------------------------------
searchBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) {
    setStatus("Enter a character name first.", "error");
    return;
  }
  runSearch(name);
});
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") searchBtn.click(); });

leagueSearchBtn.addEventListener("click", () => {
  const name = leagueNameInput.value.trim();
  if (!name) {
    setStatus("Enter a league name first.", "error");
    return;
  }
  runLeagueSearch(name);
});
leagueNameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") leagueSearchBtn.click(); });

// Deep-link support: if the page loads directly on a #char/... or
// #league/... URL (a bookmark, a shared link, or a refresh), load that
// view instead of leaving the page on the empty search screen.
if (location.hash) {
  handleHash(location.hash, { skipPush: true });
}
