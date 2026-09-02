// Zindigon ToonData | Census API client
// Docs: https://census.daybreakgames.com/

// All Census requests go through a Cloudflare Worker proxy instead of
// hitting Census directly. The Worker holds the real Census Service ID as
// a hidden server-side secret (never shipped to the browser — nobody can
// view-source this page and lift it), caches responses at Cloudflare's
// edge so repeat lookups across all visitors are instant, and detects
// Census's disguised rate-limit response before it can reach this code.
// Swapping in the approved Service ID (once Daybreak confirms it) is done
// entirely on the Worker side — nothing here needs to change for that.
const WORKER_BASE = "https://toondata-census.brandonjoea3.workers.dev";
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
//
// This full set (plus WEAPON_NAMES, MOVEMENT_MODE_NAMES, and the rest of
// WORLD_NAMES below) was cross-verified against the DCUO Bloguide Census
// app's own production lookup tables (read directly out of their live
// Angular app scope) and then confirmed against a real character's raw
// Census response pulled through our own Worker — not just taken on
// their word. That cross-check also caught a real bug: "6902" is Atomic's
// power_type_id, not a power_source_id value at all (power_source_id
// turns out to hold the equipped *weapon* type, not a power name — see
// WEAPON_NAMES below).
const POWER_TYPE_NAMES = {
  "1992462": "Rage",
  "2784": "Earth",
  "2325": "Electricity",
  "1810455": "Quantum",
  "74779": "Nature",
  "3050978": "Water",
  "2324": "Ice",
  "2666": "Fire",
  "2667": "Light",
  "6902": "Atomic",
  "7019": "Mental",
  "175798": "Gadgets",
  "197247": "Sorcery",
  "1932154": "Celestial",
  "2636096": "Munitions",
};
// power_source_id actually holds the character's equipped *weapon* type
// (Bow, Dual Pistol, Shield, etc.) — not a power name. Confirmed against a
// real character's raw Census response: BatmanI23's power_source_id
// ("1479215") is Shield, matching what the site itself shows for that
// character.
const WEAPON_NAMES = {
  "2336": "Martial Arts",
  "3312": "Two-Handed",
  "3314": "Bow",
  "3315": "Dual Pistol",
  "3316": "Dual Wield",
  "4498": "One-Handed",
  "4521": "Staff",
  "9111": "Rifle",
  "17740": "Brawling",
  "503870": "Hand Blast",
  "1479215": "Shield",
};
const MOVEMENT_MODE_NAMES = {
  "3317": "Super Speed",
  // 3313 covers both Flight and Skimming — Census exposes the same ID for
  // both, so there's no way to tell them apart from this field alone.
  "3313": "Flight / Skimming",
  "3527": "Acrobatics",
};
const WORLD_NAMES = {
  "0": "---",
  "1": "US PC/PS3",
  "2": "US PC/PS3",
  "3": "US PC/PS3",
  "4": "EU PC/PS3",
  "5001": "US Xbox",
  "5002": "EU Xbox",
};
// personality_id — the character's chosen personality/voice type.
const PERSONALITY_NAMES = {
  "389435": "Serious",
  "457291": "Primal",
  "457292": "Comical",
  "457293": "Flirty",
  "457294": "Powerful",
  "872983": "Flirty",
  "2664729": "Serious",
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
// origin_id only ever takes three values — confirmed by cross-checking
// against each origin's iconic mentor on both alignments (Tech: Batman /
// Joker, Magic: Wonder Woman / Circe, Meta: Superman / Lex Luthor).
const ORIGIN_NAMES = {
  "21784": "Tech",
  "21785": "Magic",
  "21783": "Meta",
};
// equipment_slot_id -> real slot name, so the paperdoll and gear table can
// show "Head" instead of "Slot 0". Sourced from the community DCUO
// Bloguide's own equipment-import code (the same reference used to verify
// the Combat Rating calculator above), which maps Census's
// equipment_slot_id this way when pulling a character's gear in. Slots not
// listed here fall back to a raw "Slot N" label via slotLabel() below.
// Notably absent: 2 and 8, which lines up with what this site's own data
// already showed — no character checked so far has ever had an item in
// either slot, so they're most likely unused/reserved IDs rather than
// slots this table is just missing. 14 and 16 are also absent here even
// though real characters do carry items there; that source simply doesn't
// name them (they're not part of Combat Rating, so it has no reason to),
// not evidence that they're unused like 2 and 8 are.
const ITEM_SLOT_NAMES = {
  "0": "Head",
  "1": "Neck",
  "3": "Shoulders",
  "4": "Back",
  "5": "Hands",
  "6": "Waist",
  "7": "Feet",
  "9": "Face",
  "10": "Chest",
  "11": "Legs",
  "12": "Ring 1",
  "13": "Ring 2",
  "15": "Trinket",
  "17": "Weapon",
  "18": "Trinket 1",
  "19": "Trinket 2",
  "20": "Trinket 3",
  "21": "Trinket 4",
};
function slotLabel(slotId) {
  return ITEM_SLOT_NAMES[slotId] || `Slot ${slotId}`;
}

// ---------------------------------------------------------------------
// Low-level Census fetch with retry/backoff on 429 / transient errors
// ---------------------------------------------------------------------
async function censusGet(collection, params) {
  const qs = new URLSearchParams(params);
  const url = `${WORKER_BASE}/${collection}?${qs.toString()}`;

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
      // A rate-limited Census service ID doesn't get a real HTTP 429 —
      // Census answers with HTTP 200 and a body like {"error":"Missing
      // Service ID.  A valid Service ID is required for continued api use.
      // The Service ID s:example is for casual use only.  (...)"}. Before
      // this check existed, that response fell through untouched:
      // fetchAllPages saw no *_list key, treated it as an empty page, and
      // quietly stopped paginating — so a rate-limited request came back
      // looking like "this character has 0 (or fewer) feats" instead of
      // failing. That's the confirmed root cause of the Compare feature's
      // corrupted/nondeterministic feat counts. The Worker (WORKER_BASE)
      // already detects and retries this pattern server-side before it
      // ever reaches the browser, so in normal operation this check should
      // never fire — it's kept here as a backstop in case a disguised
      // rate-limit response ever slips through. Treating it as a
      // RateLimitError routes it through the same retry/backoff as a real
      // 429, and only surfaces as a visible error if every retry is
      // exhausted — instead of silently returning bad data. This is
      // distinct from the legitimate {"error":"No data found."} response,
      // which doesn't match this pattern and still passes through as a
      // normal empty result.
      if (typeof json.error === "string" && /casual use|missing service id/i.test(json.error)) {
        throw new RateLimitError();
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
const modeCompareBtn = document.getElementById("modeCompareBtn");
const compareSearchForm = document.getElementById("compareSearchForm");
const compareNameA = document.getElementById("compareNameA");
const compareNameB = document.getElementById("compareNameB");
const compareSearchABtn = document.getElementById("compareSearchABtn");
const compareSearchBBtn = document.getElementById("compareSearchBBtn");
const compareMatchListA = document.getElementById("compareMatchListA");
const compareMatchListB = document.getElementById("compareMatchListB");
const compareSelectedA = document.getElementById("compareSelectedA");
const compareSelectedB = document.getElementById("compareSelectedB");
const compareGoBtn = document.getElementById("compareGoBtn");
const modeCrCalcBtn = document.getElementById("modeCrCalcBtn");
const crCalcForm = document.getElementById("crCalcForm");
const searchNoticesEl = document.getElementById("searchNotices");
const modeLeaderboardBtn = document.getElementById("modeLeaderboardBtn");
const leaderboardForm = document.getElementById("leaderboardForm");

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
  // Invalidates any in-flight background feat/league load from a
  // previously-rendered character view (see loadFeatsAndLeague) so it
  // can't repaint over whatever gets rendered next.
  delete resultEl.dataset.activeCharacterId;
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

// Renders one feat as a chip. Census stopped exposing feat names years
// ago, so the Worker (WORKER_BASE) attaches a recovered feat_name to each
// completed/active feat row itself, server-side, whenever it has one —
// see enrichFeatNames in the Worker source. This falls back to a raw
// "#<id>" chip for anything the Worker didn't attach a name to. Known
// names get a distinct style (see .td-feat-named in toondata.css) so it's
// obvious at a glance which feats are named vs. still just an ID; the ID
// is always in the tooltip either way.
//
// Deliberately NOT a client-side lookup table: the recovered feat_id ->
// name data lives only in the Worker, not in anything shipped to the
// browser (this site's static assets are public in GitHub Pages), so a
// visitor only ever sees names for the specific feats a specific
// character has, never the whole recovered dataset in one file.
function featChip(f) {
  const id = esc(f.feat_id);
  if (f.feat_name) return `<span class="td-feat-named" title="Feat ID ${id}">${esc(f.feat_name)}</span>`;
  return `<span title="Name not recovered yet">#${id}</span>`;
}

// ---------------------------------------------------------------------
// Mode toggle (Character search / League search / Compare)
// ---------------------------------------------------------------------
const MODES = {
  character: {
    btn: () => modeCharBtn, form: () => charSearchForm,
    title: "Character Lookup",
    lede: "Look up your DC Universe Online character's stats, gear, and feats.",
  },
  league: {
    btn: () => modeLeagueBtn, form: () => leagueSearchForm,
    title: "League Lookup",
    lede: "Look up a DC Universe Online league's roster and members.",
  },
  compare: {
    btn: () => modeCompareBtn, form: () => compareSearchForm,
    title: "Compare Characters",
    lede: "Search two characters to compare their stats, gear, and feats side by side.",
  },
  crcalc: {
    btn: () => modeCrCalcBtn, form: () => crCalcForm,
    title: "Combat Rating Calculator",
    lede: "Estimate your Combat Rating from your equipped item levels, or plan what to upgrade next.",
    // Doesn't call Census at all, so the "we'll never ask for your
    // password" / "data comes from Census" notices (which are about
    // searching) don't apply here.
    hideNotices: true,
  },
  leaderboard: {
    btn: () => modeLeaderboardBtn, form: () => leaderboardForm,
    title: "Skill Points Leaderboard",
    lede: "The highest Skill Points among characters that have been looked up here. Census doesn't expose a way to rank every character in the game, so this can only ever reflect who's actually been searched — not a true server-wide #1.",
    // No search box on this tab either.
    hideNotices: true,
  },
};
function setMode(mode) {
  Object.keys(MODES).forEach(key => {
    const m = MODES[key];
    const active = key === mode;
    m.form().style.display = active ? "" : "none";
    m.btn().classList.toggle("active", active);
    m.btn().setAttribute("aria-selected", String(active));
  });
  pageTitleEl.textContent = MODES[mode].title;
  pageLedeEl.textContent = MODES[mode].lede;
  searchNoticesEl.style.display = MODES[mode].hideNotices ? "none" : "";
}
modeCharBtn.addEventListener("click", () => setMode("character"));
modeLeagueBtn.addEventListener("click", () => setMode("league"));
modeCompareBtn.addEventListener("click", () => setMode("compare"));
modeCrCalcBtn.addEventListener("click", () => setMode("crcalc"));
modeLeaderboardBtn.addEventListener("click", () => {
  setMode("leaderboard");
  loadLeaderboardData();
});

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
  } else if (data.type === "compare") {
    renderComparison(data.dataA, data.dataB);
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
  const compareMatch = hash.match(/^#compare\/(\d+)\/(\d+)$/);
  if (charMatch) {
    loadCharacterById(charMatch[1], opts);
  } else if (leagueMatch) {
    loadLeagueRoster(leagueMatch[1], null, opts);
  } else if (compareMatch) {
    loadComparison(compareMatch[1], compareMatch[2], opts);
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

    // Identity, stats, and gear are the fast part — one request, already in
    // hand. Feats and league are the slow part: a character with a lot of
    // feats can mean several sequential paginated requests, and visitors
    // shouldn't have to stare at a blank page while those finish. So the
    // page renders right now with what's already loaded, and feats/league
    // stream in afterward, updating this same view in place once ready —
    // see loadFeatsAndLeague below.
    clearStatus();
    loadFeatsAndLeague(character, equippedItems, characterId, cacheKey);

  } catch (err) {
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  }
}

// Looks up a character's league membership by character_id. Returns null
// both when the character isn't in a league and when the lookup itself
// fails — a missing league tag isn't worth surfacing as an error the way a
// missing feat list is (feats silently reading as empty was the confirmed
// cause of the Compare feature's earlier data-corruption bug; a league tag
// silently reading "None" carries none of that risk).
async function fetchLeagueInfo(characterId) {
  try {
    const rosterJson = await censusGet("guild_roster", { character_id: characterId });
    const membership = (rosterJson.guild_roster_list || [])[0];
    if (!membership) return null;
    const guildJson = await censusGet("guild", { guild_id: membership.guild_id });
    const guildInfo = (guildJson.guild_list || [])[0];
    return { guild_id: membership.guild_id, rank: membership.rank, name: guildInfo ? guildInfo.name : null };
  } catch (e) {
    return null;
  }
}

// Fetches feats and league in the background after showCharacter has
// already rendered identity/stats/gear, and repaints just that view once
// each piece is ready — independently, so a slow or failed feats load
// doesn't hold up a league tag that resolved fine, or vice versa. Kept as
// its own function (rather than inlined in showCharacter) so the Retry
// button on a failed feats load — wired up in renderCharacter — can call
// straight back into it.
function loadFeatsAndLeague(character, equippedItems, characterId, cacheKey) {
  const characterIdStr = String(characterId);
  // completedFeats stays null until that fetch resolves; league stays
  // undefined until its fetch resolves (null is itself a valid resolved
  // "no league" answer, so it has to be distinguishable from "not fetched
  // yet" — undefined is that marker).
  const state = { completedFeats: null, activeFeats: null, featsError: false, league: undefined };

  // Claims resultEl for this characterId right away, before the first
  // repaint() call below — otherwise that very first call would find
  // resultEl still marked with whatever the previous view left behind (or
  // nothing, right after clearResult()) and immediately think itself stale.
  // renderCharacter re-sets this on every call anyway; this just covers the
  // gap before it's run for the first time.
  resultEl.dataset.activeCharacterId = characterIdStr;

  // If the visitor has navigated to a different view since this load
  // started (a new search, Back/Forward, a different character), resultEl
  // no longer belongs to this characterId — clearResult() (called by every
  // navigation path) deletes this dataset value, and renderCharacter resets
  // it to whichever character it just rendered. Either way, a mismatch here
  // means this load is stale and shouldn't touch the DOM anymore.
  function isStale() { return resultEl.dataset.activeCharacterId !== characterIdStr; }

  function repaint() {
    if (isStale()) return;
    const featsLoading = state.completedFeats === null && !state.featsError;
    const leagueLoading = state.league === undefined;
    renderCharacter(
      character, equippedItems,
      state.completedFeats || [], state.activeFeats || [],
      state.league || null,
      {
        featsLoading, featsError: state.featsError, leagueLoading,
        onRetryFeats: () => {
          state.featsError = false;
          state.completedFeats = null;
          state.activeFeats = null;
          repaint();
          loadFeats();
        },
      }
    );
    if (!featsLoading && !state.featsError && !leagueLoading) {
      cacheView(cacheKey, {
        type: "character", character, equippedItems,
        completedFeats: state.completedFeats, activeFeats: state.activeFeats, league: state.league,
      });
    }
  }

  function loadFeats() {
    Promise.all([
      fetchAllPages("characters_completed_feat", { character_id: characterId }),
      fetchAllPages("characters_active_feat", { character_id: characterId }),
    ]).then(([completed, active]) => {
      state.completedFeats = completed;
      state.activeFeats = active;
      state.featsError = false;
      repaint();
    }).catch(() => {
      state.featsError = true;
      repaint();
    });
  }

  function loadLeague() {
    fetchLeagueInfo(characterId).then(league => {
      state.league = league;
      repaint();
    });
  }

  repaint(); // paints the loading skeleton immediately
  loadFeats();
  loadLeague();
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

// Fetches everything renderCharacter/renderComparison need for one
// character_id — the character record itself plus gear/feats/league —
// as a single bundle. Used by the comparison flow, which needs two of
// these at once. Kept separate from showCharacter (which assumes the
// caller already has the character record from a name search) so that
// existing, already-verified flow isn't touched.
async function fetchCharacterFullData(characterId) {
  const charJson = await censusGet("character", { character_id: characterId });
  const character = (charJson.character_list || [])[0];
  if (!character) return null;

  const itemsJson = await censusGet("characters_item", { character_id: characterId, "c:limit": 500 });
  const equippedItems = (itemsJson.characters_item_list || [])
    .sort((a, b) => Number(a.equipment_slot_id) - Number(b.equipment_slot_id));

  // Completed/active feats and league are independent requests, so they run
  // concurrently rather than one after another — same reasoning as the
  // background load in loadFeatsAndLeague above, just awaited here instead
  // of streamed in, since the compare flow renders both characters at once
  // rather than progressively.
  const [completedFeats, activeFeats, league] = await Promise.all([
    fetchAllPages("characters_completed_feat", { character_id: characterId }),
    fetchAllPages("characters_active_feat", { character_id: characterId }),
    fetchLeagueInfo(characterId),
  ]);

  return { character, equippedItems, completedFeats, activeFeats, league };
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

// ---------------------------------------------------------------------
// Compare flow — resolve two character names to two character_ids (each
// side independently, since a name can be ambiguous on either side), then
// load both full profiles and render them side by side.
// ---------------------------------------------------------------------
const compareSelection = { A: null, B: null }; // { id, name } per side, once resolved

function compareSideRefs(side) {
  return side === "A"
    ? { input: compareNameA, btn: compareSearchABtn, matchList: compareMatchListA, selectedEl: compareSelectedA }
    : { input: compareNameB, btn: compareSearchBBtn, matchList: compareMatchListB, selectedEl: compareSelectedB };
}

function setCompareSelection(side, id, name) {
  compareSelection[side] = id ? { id, name } : null;
  const { matchList, selectedEl, input } = compareSideRefs(side);
  matchList.innerHTML = "";
  if (id) {
    selectedEl.style.display = "";
    selectedEl.innerHTML = `Selected: <strong>${esc(name)}</strong> <button type="button">Change</button>`;
    selectedEl.querySelector("button").addEventListener("click", () => {
      setCompareSelection(side, null, null);
      input.value = "";
      input.focus();
    });
  } else {
    selectedEl.style.display = "none";
    selectedEl.innerHTML = "";
  }
  compareGoBtn.disabled = !(compareSelection.A && compareSelection.B);
}

async function runCompareSideSearch(side) {
  const { input, btn, matchList } = compareSideRefs(side);
  const name = input.value.trim();
  if (!name) {
    setStatus(`Enter a name for the ${side === "A" ? "first" : "second"} character.`, "error");
    return;
  }
  clearStatus();
  matchList.innerHTML = "";
  btn.disabled = true;
  try {
    const charJson = await censusGet("character", { name });
    const matches = charJson.character_list || [];

    if (matches.length === 0) {
      setStatus(`No character named "${name}" was found.`, "error");
      return;
    }
    if (matches.length > 1) {
      setStatus(`More than one character is named "${name}". Pick the right one:`, "warn");
      matchList.innerHTML = matches.map(m => `
        <div class="td-match-item" data-character-id="${esc(m.character_id)}" data-character-name="${esc(m.name)}">
          <span>${esc(m.name)}, Level ${esc(m.level)}</span>
          <span>Combat Rating ${esc(m.combat_rating)}</span>
        </div>
      `).join("");
      [...matchList.children].forEach(el => {
        el.addEventListener("click", () => {
          clearStatus();
          setCompareSelection(side, el.dataset.characterId, el.dataset.characterName);
        });
      });
      return;
    }

    clearStatus();
    setCompareSelection(side, matches[0].character_id, matches[0].name);
  } catch (err) {
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  } finally {
    btn.disabled = false;
  }
}

compareSearchABtn.addEventListener("click", () => runCompareSideSearch("A"));
compareSearchBBtn.addEventListener("click", () => runCompareSideSearch("B"));
compareNameA.addEventListener("keydown", (e) => { if (e.key === "Enter") runCompareSideSearch("A"); });
compareNameB.addEventListener("keydown", (e) => { if (e.key === "Enter") runCompareSideSearch("B"); });
compareGoBtn.addEventListener("click", () => {
  if (!compareSelection.A || !compareSelection.B) return;
  loadComparison(compareSelection.A.id, compareSelection.B.id);
});

// Loads two full character profiles, one after the other, and renders them
// side by side. Pushes #compare/<idA>/<idB> and caches the same way
// character and league views do, so Back returns here instantly within the
// cache window.
async function loadComparison(idA, idB, opts) {
  opts = opts || {};
  const cacheKey = `compare:${idA}:${idB}`;
  if (!opts.skipPush) pushView(`#compare/${idA}/${idB}`);

  const cached = getFreshView(cacheKey);
  if (cached) {
    applyView(cached);
    return;
  }

  clearStatus();
  clearMatches();
  clearResult();
  // Fetched one at a time, not in parallel. The shared "s:example" Census
  // key has a tight, undocumented rate limit, and comparing doubles the
  // number of requests in flight at once (character + gear + two feat
  // collections + league, times two people). Running both characters
  // concurrently was making that limit far more likely to be hit — which,
  // before the censusGet fix above, silently corrupted the results instead
  // of failing loudly. Sequential fetches keep peak load the same as a
  // single character lookup.
  setStatus("Loading first character...");
  try {
    const dataA = await fetchCharacterFullData(idA);
    setStatus("Loading second character...");
    const dataB = await fetchCharacterFullData(idB);

    if (!dataA || !dataB) {
      setStatus("One of those characters couldn't be loaded — they may have transferred, been renamed, or been deleted.", "error");
      return;
    }

    clearStatus();
    renderComparison(dataA, dataB);
    cacheView(cacheKey, { type: "compare", idA, idB, dataA, dataB });
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
  // Invalidates any in-flight background feat/league load from a
  // previously-rendered character view (see loadFeatsAndLeague) so it
  // can't repaint over this roster.
  delete resultEl.dataset.activeCharacterId;
  // dir: 1 = ascending, -1 = descending. resumeSort carries the sort the
  // user had chosen when this same roster was last rendered (Back, or
  // searching the same league again within the cache window), so it isn't
  // silently reset to fetch order.
  const sortState = resumeSort ? { ...resumeSort } : { key: null, dir: 1 };
  // Roster members picked for a head-to-head compare, capped at 2. Resets
  // whenever this roster is freshly loaded (a new search, or navigating
  // back into it after the sort/back-button fixes above) — carrying a
  // selection across an unrelated view isn't worth the added complexity.
  const selected = new Set();

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
      const checked = selected.has(m.character_id) ? "checked" : "";
      return `<tr class="td-roster-row" data-character-id="${esc(m.character_id)}" tabindex="0">
        <td class="td-roster-select-td"><input type="checkbox" class="td-roster-checkbox" data-character-id="${esc(m.character_id)}" data-character-name="${name}" ${checked} /></td>
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
      const go = (e) => {
        // Clicking the checkbox should select it, not navigate away.
        if (e.target && e.target.closest(".td-roster-checkbox")) return;
        loadCharacterById(row.dataset.characterId);
      };
      row.addEventListener("click", go);
      row.addEventListener("keydown", (e) => { if (e.key === "Enter") go(e); });
    });
    resultEl.querySelectorAll(".td-roster-checkbox").forEach(cb => {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => {
        const id = cb.dataset.characterId;
        if (cb.checked) {
          if (selected.size >= 2) { cb.checked = false; return; }
          selected.add(id);
        } else {
          selected.delete(id);
        }
        updateCheckboxAvailability();
        updateCompareButtonState();
      });
    });
  }

  // Once 2 members are picked, grey out the remaining checkboxes rather
  // than silently ignoring further clicks — makes the 2-person cap obvious
  // instead of the roster just appearing to stop responding.
  function updateCheckboxAvailability() {
    const atLimit = selected.size >= 2;
    resultEl.querySelectorAll(".td-roster-checkbox").forEach(cb => {
      if (!cb.checked) cb.disabled = atLimit;
    });
  }

  function updateCompareButtonState() {
    const btn = resultEl.querySelector("#rosterCompareBtn");
    if (!btn) return;
    btn.disabled = selected.size !== 2;
    btn.textContent = selected.size === 2 ? "Compare Selected" : `Compare Selected (${selected.size}/2)`;
  }

  function attachCompareButton() {
    const btn = resultEl.querySelector("#rosterCompareBtn");
    if (!btn) return;
    btn.addEventListener("click", () => {
      const ids = [...selected];
      if (ids.length !== 2) return;
      loadComparison(ids[0], ids[1]);
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
    updateCheckboxAvailability();
    updateCompareButtonState();
    cacheCurrent();
  }

  resultEl.innerHTML = `
    <div class="td-roster">
      <p class="td-section-label">League — ${esc(guildName)} (${members.length} member${members.length === 1 ? "" : "s"})</p>
      <table class="td-roster-table">
        <thead><tr>
          <th class="td-roster-select-th">Compare</th>
          <th class="sortable" data-sort-key="name">Name</th>
          <th>Level</th>
          <th class="sortable" data-sort-key="cr">Combat Rating</th>
          <th class="sortable" data-sort-key="sp">Skill Points</th>
          <th>Rank</th>
        </tr></thead>
        <tbody>${buildRowsHtml(sortedMembers())}</tbody>
      </table>
      <p class="td-roster-note">Click a member to see their full profile. Click Name, Combat Rating, or Skill Points to sort — click again to reverse. Check exactly 2 members and click Compare Selected to see them side by side. Rank is shown as the game's raw rank number — Census doesn't provide rank names like Leader or Officer. A roster reflects Census data at the moment it loaded; search again to refresh it.</p>
      <div class="td-roster-actions">
        <button type="button" id="rosterCompareBtn" class="btn btn-secondary" disabled>Compare Selected (0/2)</button>
      </div>
    </div>
  `;
  resultEl.className = "td-result show";
  attachRowHandlers();
  updateHeaderIndicators();
  updateCheckboxAvailability();
  updateCompareButtonState();
  attachCompareButton();
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
function renderCharacter(c, items, completedFeats, activeFeats, league, opts) {
  opts = opts || {};
  const featsLoading = !!opts.featsLoading;
  const featsError = !!opts.featsError;
  const leagueLoading = !!opts.leagueLoading;
  // Marks this as the character currently on screen, so a background
  // feat/league load in flight for a DIFFERENT character (or for a view the
  // visitor has since navigated away from) knows not to repaint over
  // whatever just got rendered — see loadFeatsAndLeague.
  resultEl.dataset.activeCharacterId = String(c.character_id);

  // esc() alone turns a genuinely missing field into the literal text
  // "undefined" (String(undefined) === "undefined") — this is what was
  // showing up under Title for characters Census doesn't return a
  // title_id for. Falls back to "None" instead, same as every other
  // field that uses this helper.
  const kv = (label, value) => `<div><div class="k">${esc(label)}</div><div class="v">${value === undefined || value === null || value === "" ? "None" : esc(value)}</div></div>`;
  const row = (label, value) => `<div class="td-row"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;

  const itemRows = items.map(it => `
    <tr>
      <td>${esc(slotLabel(it.equipment_slot_id))} <span class="td-slot-id">(${esc(it.equipment_slot_id)})</span></td>
      <td>${esc(it.item_id)}</td>
      <td>${it.is_bound === "true" ? "Yes" : "No"}</td>
      <td>${[it.aug_item_id_1, it.aug_item_id_2, it.aug_item_id_3].filter(v => v && v !== "-1").join(", ") || "None"}</td>
    </tr>
  `).join("");

  // Paperdoll — slot 0-7 flank the left, 8-15 flank the right, fixed at
  // that size so the two columns stay a predictable height next to the
  // silhouette instead of stretching it. Each chip's label now comes from
  // slotLabel() (Head, Chest, Legs, etc. — see ITEM_SLOT_NAMES above)
  // rather than a raw slot number; the fixed left/right grouping itself is
  // still just even spacing, not an anatomical paperdoll layout.
  //
  // Not every equipped item lives in that 0-15 range — weapon (17),
  // trinket (18-21), and further artifact/stat-mod slots beyond that use
  // higher slot IDs. Those still show up in the "All equipped items" table
  // below. Rather than appending them to the flanking columns (which is
  // what made the paperdoll balloon and stretch when a character had gear
  // in those slots), they get their own small expandable list right under
  // the paperdoll — collapsed by default, same pattern as the
  // equipped-items table — so nothing is silently missing from view
  // without the fixed layout blowing up.
  //
  // Slots 2 and 8 specifically are not a display bug: real Census data for
  // every character checked so far (including this one) simply has no
  // item recorded at those two IDs at all, so "Empty" here is accurate,
  // not a matching failure.
  const bySlot = {};
  items.forEach(it => { bySlot[it.equipment_slot_id] = it; });
  // Slot 15 was missing from this list even though it's clearly a body-gear
  // slot like 0-14 (its item ID sits right in the same cluster as the
  // other core slots' item IDs, unlike the weapon/artifact/trinket-style
  // slots at 17+) — it was falling into the "extra slots" bucket below
  // instead of the paperdoll. Confirmed against real equipped items before
  // adding it here.
  const KNOWN_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const slotChip = (slotId) => {
    const it = bySlot[slotId];
    return `<div class="td-slot-chip">
      <span class="n">${esc(slotLabel(String(slotId)))}</span>
      <span class="v${it ? "" : " empty"}">${it ? esc(it.item_id) : "Empty"}</span>
    </div>`;
  };
  const leftSlots = [0, 1, 2, 3, 4, 5, 6, 7].map(slotChip).join("");
  const rightSlots = [8, 9, 10, 11, 12, 13, 14, 15].map(slotChip).join("");

  const extraSlotIds = Object.keys(bySlot)
    .map(Number)
    .filter(n => !KNOWN_SLOTS.includes(n))
    .sort((a, b) => a - b);
  const extraSlotsHtml = extraSlotIds.map(slotChip).join("");

  const featIdSpans = (list) => list.map(featChip).join("");

  const roleLabel = ALIGNMENT_NAMES[c.alignment_id] || null;

  const leagueName = leagueLoading ? "Loading…" : (league && league.name ? esc(league.name) : "None");
  const leagueLink = !leagueLoading && league && league.guild_id
    ? `<a href="#league/${esc(league.guild_id)}" class="td-league-link" data-guild-id="${esc(league.guild_id)}" data-guild-name="${leagueName}">${leagueName}</a>`
    : leagueName;

  // Simple stroke icons matching the site's brand-mark style. Power source
  // still has no known name lookup, so it's shown as a raw ID further down.
  const powerIcon = `<svg viewBox="0 0 16 16"><path d="M9 1 L3 9 L7 9 L6 15 L13 6 L9 6 Z"/></svg>`;
  const moveIcon = `<svg viewBox="0 0 16 16"><path d="M2 11 L7 6 M5 13 L10 8 M8 15 L13 10"/></svg>`;
  const powerTypeLabel = POWER_TYPE_NAMES[c.power_type_id] || `#${c.power_type_id}`;
  const movementLabel = MOVEMENT_MODE_NAMES[c.movement_mode_id] || `#${c.movement_mode_id}`;
  const worldLabel = WORLD_NAMES[c.world_id] || `#${c.world_id}`;

  // Feats are the slowest thing this page loads (a well-feated character
  // can mean several sequential paginated requests), so this section has
  // three states instead of just one: a loading skeleton shown the instant
  // the rest of the page renders, an error state with a Retry button if the
  // background fetch fails, and the real counts/lists once it succeeds. See
  // loadFeatsAndLeague, which drives which of these gets passed in via opts.
  const featsSectionHtml = featsLoading ? `
    <div class="td-feat-summary">
      <div class="kv-single"><div class="k">Completed</div><div class="v td-loading">···</div></div>
      <div class="kv-single"><div class="k">In Progress</div><div class="v td-loading">···</div></div>
    </div>
    <p class="td-roster-note">Loading feat data — characters with a lot of feats can take a few seconds.</p>
  ` : featsError ? `
    <div class="notice">
      <span>Feat data couldn't be loaded. <button type="button" id="retryFeatsBtn" class="btn btn-secondary" style="margin-left:8px;">Retry</button></span>
    </div>
  ` : `
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
  `;

  resultEl.innerHTML = `
    <div class="td-identity">
      <div>
        <div class="td-name">${esc(c.name)}</div>
        <div class="td-identity-tags">
          ${roleLabel ? `<span class="td-tag td-role-tag">${esc(roleLabel)}</span>` : ""}
          <span class="td-tag">League <strong${leagueLoading ? ' class="td-loading"' : ""}>${leagueLink}</strong></span>
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
          ${kv("Weapon", WEAPON_NAMES[c.power_source_id] || c.power_source_id)}
          ${kv("Gender", GENDER_NAMES[c.gender_id] || c.gender_id)}
          ${kv("Origin", ORIGIN_NAMES[c.origin_id] || c.origin_id)}
          ${kv("Title", c.title_id)}
          ${kv("Personality", PERSONALITY_NAMES[c.personality_id] || c.personality_id)}
          ${kv("Region", c.region_id)}
        </div>
      </div>
    </div>

    <div class="card" style="margin-top:32px;">
      <p class="td-section-label">Feats</p>
      ${featsSectionHtml}
    </div>

    <div class="card" style="margin-top:20px;">
      <p class="td-section-label">About this data</p>
      <ul class="td-limitations">
        <li>Feat names come from an archived, recovered list, not Census (it stopped providing feat names years ago) — coverage is partial and frozen at mid-2015, so newer feats show as a raw ID (#…) instead of a name.</li>
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

  const retryFeatsBtn = resultEl.querySelector("#retryFeatsBtn");
  if (retryFeatsBtn && opts.onRetryFeats) {
    retryFeatsBtn.addEventListener("click", opts.onRetryFeats);
  }
}

// ---------------------------------------------------------------------
// Comparison render — two characters, side by side: identity, stats, gear,
// and a two-way feat diff (completed feats one has that the other doesn't).
// ---------------------------------------------------------------------

// Builds the same paperdoll markup renderCharacter uses, factored out so
// the comparison view can render one per side without duplicating the
// slot-layout logic twice inline. renderCharacter keeps its own inline
// copy rather than being refactored to call this, so that already-verified
// code path stays untouched.
function buildPaperdollHtml(items) {
  const bySlot = {};
  items.forEach(it => { bySlot[it.equipment_slot_id] = it; });
  // Kept in sync with the KNOWN_SLOTS list in renderCharacter above —
  // slot 15 belongs in the paperdoll grid, not the "extra slots" bucket.
  const KNOWN_SLOTS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const slotChip = (slotId) => {
    const it = bySlot[slotId];
    return `<div class="td-slot-chip">
      <span class="n">${esc(slotLabel(String(slotId)))}</span>
      <span class="v${it ? "" : " empty"}">${it ? esc(it.item_id) : "Empty"}</span>
    </div>`;
  };
  const leftSlots = [0, 1, 2, 3, 4, 5, 6, 7].map(slotChip).join("");
  const rightSlots = [8, 9, 10, 11, 12, 13, 14, 15].map(slotChip).join("");
  const extraSlotIds = Object.keys(bySlot).map(Number).filter(n => !KNOWN_SLOTS.includes(n)).sort((a, b) => a - b);
  const extraSlotsHtml = extraSlotIds.map(slotChip).join("");

  return `
    <div class="td-paperdoll">
      <div class="td-paperdoll-slots">${leftSlots}</div>
      <div class="td-paperdoll-figure"><img src="paperdoll-silhouette.png" alt="" /></div>
      <div class="td-paperdoll-slots">${rightSlots}</div>
    </div>
    ${extraSlotIds.length ? `
    <details class="td-extra-slots">
      <summary class="td-section-label">More equipped slots (${extraSlotIds.length})</summary>
      <div class="td-extra-slots-grid">${extraSlotsHtml}</div>
    </details>
    ` : ""}
  `;
}

function buildItemRowsHtml(items) {
  return items.map(it => `
    <tr>
      <td>${esc(slotLabel(it.equipment_slot_id))} <span class="td-slot-id">(${esc(it.equipment_slot_id)})</span></td>
      <td>${esc(it.item_id)}</td>
      <td>${it.is_bound === "true" ? "Yes" : "No"}</td>
      <td>${[it.aug_item_id_1, it.aug_item_id_2, it.aug_item_id_3].filter(v => v && v !== "-1").join(", ") || "None"}</td>
    </tr>
  `).join("");
}

function renderComparison(dataA, dataB) {
  // Invalidates any in-flight background feat/league load from a
  // previously-rendered character view (see loadFeatsAndLeague) so it
  // can't repaint over this comparison.
  delete resultEl.dataset.activeCharacterId;
  const { character: a, equippedItems: itemsA, completedFeats: completedA, league: leagueA } = dataA;
  const { character: b, equippedItems: itemsB, completedFeats: completedB, league: leagueB } = dataB;

  const nameA = esc(a.name);
  const nameB = esc(b.name);

  const identitySide = (c, league) => {
    const roleLabel = ALIGNMENT_NAMES[c.alignment_id] || null;
    const leagueLabel = league && league.name ? esc(league.name) : "None";
    const worldLabel = esc(WORLD_NAMES[c.world_id] || `#${c.world_id}`);
    return `
      <div>
        <div class="td-compare-side-label">${esc(c.name)}</div>
        <div class="td-identity-tags">
          ${roleLabel ? `<span class="td-tag td-role-tag">${esc(roleLabel)}</span>` : ""}
          <span class="td-tag">League <strong>${leagueLabel}</strong></span>
          <span class="td-tag">Server <strong>${worldLabel}</strong></span>
        </div>
      </div>
    `;
  };

  // Stat rows shown side by side, with the higher value (when the two
  // differ and both are real numbers) highlighted so the comparison is
  // readable at a glance rather than requiring the reader to do the math.
  const STAT_ROWS = [
    ["Combat Rating", "combat_rating"],
    ["Skill Points", "skill_points"],
    ["Level", "level"],
    ["PvP Combat Rating", "pvp_combat_rating"],
    ["Health", "max_health"],
    ["Power", "max_power"],
    ["Might", "might"],
    ["Precision", "precision"],
    ["Restoration", "restoration"],
    ["Vitalization", "vitalization"],
    ["Dominance", "dominance"],
    ["Defense", "defense"],
    ["Toughness", "toughness"],
  ];
  const statRowsHtml = STAT_ROWS.map(([label, field]) => {
    const rawA = Number(a[field]);
    const rawB = Number(b[field]);
    const bothNumeric = !Number.isNaN(rawA) && !Number.isNaN(rawB) && a[field] !== undefined && b[field] !== undefined;
    const aHigher = bothNumeric && rawA > rawB;
    const bHigher = bothNumeric && rawB > rawA;
    return `<tr>
      <td>${esc(label)}</td>
      <td class="${aHigher ? "td-stat-better" : ""}">${fmt(a[field])}</td>
      <td class="${bHigher ? "td-stat-better" : ""}">${fmt(b[field])}</td>
    </tr>`;
  }).join("");

  // Two-way feat diff: completed feats unique to each side. Shared feats
  // and feats neither has completed aren't shown — the point is to
  // surface the difference, not repeat the full list twice.
  const idsA = new Set(completedA.map(f => f.feat_id));
  const idsB = new Set(completedB.map(f => f.feat_id));
  const onlyA = completedA.filter(f => !idsB.has(f.feat_id));
  const onlyB = completedB.filter(f => !idsA.has(f.feat_id));
  const featIdSpans = (list) => list.length
    ? list.map(featChip).join("")
    : `<span class="td-roster-note" style="margin:0;">None</span>`;

  // Defense-in-depth: even with the censusGet rate-limit fix, don't let the
  // page confidently show "no feat differences" when the two characters'
  // Skill Point totals prove that can't be right. Two distinct characters
  // whose completed-feat sets are byte-for-byte identical, but whose SP
  // differs, means the feat data behind this particular comparison is
  // incomplete — surface that instead of implying they're feat-identical.
  const spA = Number(a.skill_points);
  const spB = Number(b.skill_points);
  const spDiffers = !Number.isNaN(spA) && !Number.isNaN(spB) && spA !== spB;
  const noFeatDiff = onlyA.length === 0 && onlyB.length === 0;
  const featDataSuspect = noFeatDiff && spDiffers;

  resultEl.innerHTML = `
    <div class="td-compare">
      <div class="td-compare-columns td-compare-identity-row">
        ${identitySide(a, leagueA)}
        ${identitySide(b, leagueB)}
      </div>

      <div class="card">
        <p class="td-section-label">Stats</p>
        <table class="td-compare-stats-table">
          <thead><tr><th></th><th>${nameA}</th><th>${nameB}</th></tr></thead>
          <tbody>${statRowsHtml}</tbody>
        </table>
      </div>

      <div class="card" style="margin-top:20px;">
        <p class="td-section-label">Gear</p>
        <div class="td-compare-columns">
          <div>
            <p class="td-compare-side-label" style="font-size:15px;">${nameA}</p>
            ${buildPaperdollHtml(itemsA)}
            <details class="td-gear-details">
              <summary class="td-section-label">All equipped items (${itemsA.length})</summary>
              <table class="td-gear-table">
                <thead><tr><th>Slot</th><th>Item ID</th><th>Bound</th><th>Mods</th></tr></thead>
                <tbody>${buildItemRowsHtml(itemsA)}</tbody>
              </table>
            </details>
          </div>
          <div>
            <p class="td-compare-side-label" style="font-size:15px;">${nameB}</p>
            ${buildPaperdollHtml(itemsB)}
            <details class="td-gear-details">
              <summary class="td-section-label">All equipped items (${itemsB.length})</summary>
              <table class="td-gear-table">
                <thead><tr><th>Slot</th><th>Item ID</th><th>Bound</th><th>Mods</th></tr></thead>
                <tbody>${buildItemRowsHtml(itemsB)}</tbody>
              </table>
            </details>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:20px;">
        <p class="td-section-label">Feats — completed by one, not the other</p>
        ${featDataSuspect ? `
        <div class="notice" style="margin-bottom:14px;">
          <span>No differences were returned by Census, although the characters' Skill Point totals differ. Feat data may be incomplete — try running the comparison again.</span>
        </div>
        ` : ""}
        <div class="td-compare-columns">
          <div>
            <p class="td-compare-side-label" style="font-size:15px;">Only ${nameA} (${onlyA.length})</p>
            <div class="td-feat-ids">${featIdSpans(onlyA)}</div>
          </div>
          <div>
            <p class="td-compare-side-label" style="font-size:15px;">Only ${nameB} (${onlyB.length})</p>
            <div class="td-feat-ids">${featIdSpans(onlyB)}</div>
          </div>
        </div>
        <p class="td-roster-note" style="margin-top:16px;">Shared completed feats, and feats neither has completed, aren't listed here — this only shows the difference. Feat names come from an archived, recovered list and are only available for feats that existed by mid-2015; newer feats show as a raw ID.</p>
      </div>
    </div>
  `;
  resultEl.className = "td-result show";
}

// ---------------------------------------------------------------------
// Combat Rating calculator — a standalone tool, no Census calls involved.
//
// In DCUO, Combat Rating is the weighted average item level of your 14
// equipped gear slots — but "weighted" is doing a lot of work there: some
// slots (weapon, chest, legs) count for noticeably more than others (a
// ring or trinket). Census doesn't expose the weights or the formula
// itself anywhere, so these are cross-checked against the community
// reference calculator at
// https://dcuobloguide.com/tools/combat-rating-calculator/ — read directly
// out of that page's own calculator script (each slot's <input> carries
// its weight as a data-weight attribute, e.g. data-weight="0.12" for the
// weapon slot), not guessed from what's displayed on the page.
//
// The 14 weights below sum to 1.15, not 1 — that's not a bug. Combat
// Rating is defined as 115% of the weighted item level, and that 115% is
// already baked into the per-slot weights rather than applied as a
// separate multiplier afterward. So the formula is simply:
//   CR = sum(itemLevel_i * weight_i) across all 14 slots
// with no additional step.
const CR_SLOTS = [
  { key: "head", label: "Head", weight: 0.11 },
  { key: "face", label: "Face", weight: 0.06 },
  { key: "neck", label: "Neck", weight: 0.06 },
  { key: "shoulders", label: "Shoulders", weight: 0.09 },
  { key: "chest", label: "Chest", weight: 0.12 },
  { key: "back", label: "Back (Cape)", weight: 0.08 },
  { key: "hands", label: "Hands", weight: 0.07 },
  { key: "waist", label: "Waist (Belt)", weight: 0.07 },
  { key: "legs", label: "Legs", weight: 0.12 },
  { key: "feet", label: "Feet (Boots)", weight: 0.07 },
  { key: "ring1", label: "Ring 1", weight: 0.06 },
  { key: "ring2", label: "Ring 2", weight: 0.06 },
  { key: "trinket", label: "Trinket", weight: 0.06 },
  { key: "weapon", label: "Weapon", weight: 0.12 },
];

function buildCrCalcHtml() {
  const slotsHtml = CR_SLOTS.map(s => `
    <div class="td-cr-slot">
      <label for="cr-${s.key}">
        <span class="td-cr-slot-name">${esc(s.label)}</span>
        <span class="td-cr-slot-weight">${Math.round(s.weight * 100)}%</span>
      </label>
      <input type="number" inputmode="numeric" min="0" step="1" id="cr-${s.key}" class="input td-cr-input" placeholder="0" />
    </div>
  `).join("");

  crCalcForm.innerHTML = `
    <div class="td-cr-fillall">
      <label for="cr-fillall">Set every slot to</label>
      <input type="number" inputmode="numeric" min="0" step="1" id="cr-fillall" class="input" placeholder="e.g. 400" />
    </div>
    <p class="td-roster-note" style="margin-top:8px;">Type an item level above and every slot below fills in with it as you type — then adjust any slots that are different before reading your total.</p>

    <div class="td-cr-grid">${slotsHtml}</div>

    <div class="td-hero-stats" style="grid-template-columns:1fr; margin-top:24px;">
      <div class="td-hero-stat">
        <div class="v" id="cr-total">0.00</div>
        <div class="k">Estimated Combat Rating</div>
      </div>
    </div>

    <p class="td-roster-note" style="margin-top:14px;">
      Some slots count toward Combat Rating more than others — weapon, chest, and legs carry the most weight, rings and trinket the least — which is why maxing out one slot won't move your CR as much as a lower item level spread evenly across all 14. This is an estimate for planning upgrades; your character's actual Combat Rating (visible from the Character tab) is the source of truth.
    </p>
  `;
}

function initCrCalc() {
  buildCrCalcHtml();

  function recompute() {
    let total = 0;
    let anyInvalid = false;
    CR_SLOTS.forEach(s => {
      const raw = document.getElementById(`cr-${s.key}`).value.trim();
      if (raw === "") return; // an empty slot contributes 0, same as the reference calculator
      const n = Number(raw);
      if (Number.isNaN(n)) { anyInvalid = true; return; }
      total += n * s.weight;
    });
    document.getElementById("cr-total").textContent = anyInvalid ? "—" : total.toFixed(2);
  }

  CR_SLOTS.forEach(s => {
    document.getElementById(`cr-${s.key}`).addEventListener("input", recompute);
  });

  // Live-fills every slot as you type, rather than waiting for a separate
  // "Apply" click — matches the reference calculator's behavior, and is
  // the fast path for the common case where most of a character's gear is
  // the same item level.
  document.getElementById("cr-fillall").addEventListener("input", (e) => {
    const val = e.target.value;
    CR_SLOTS.forEach(s => { document.getElementById(`cr-${s.key}`).value = val; });
    recompute();
  });
}
initCrCalc();

// ---------------------------------------------------------------------
// Skill Points leaderboard + "still cached" recently-looked-up list
//
// Both come from the Worker's own /leaderboard and /recent endpoints
// (not real Census collections — see the Worker source). The leaderboard
// can only ever reflect characters that have actually been searched here,
// since Census has no "rank everyone" endpoint — that's spelled out in
// the tab's lede above rather than left implicit.
//
// The recently-looked-up list intentionally does NOT show "last N people
// searched" — it shows only whichever of those are still an actual cache
// hit right now, verified live by the Worker at request time. Clicking
// one is guaranteed to load instantly; a lookup that's since fallen out
// of cache just quietly isn't in the list anymore rather than sitting
// there as a link that turns out to reload from scratch anyway.
// ---------------------------------------------------------------------
function buildLeaderboardSkeleton() {
  leaderboardForm.innerHTML = `
    <div class="td-lb-layout">
      <div class="card td-lb-main">
        <p class="td-section-label">Skill Points Leaderboard</p>
        <div id="lbTableWrap"><div class="td-loading" style="height:240px;"></div></div>
      </div>
      <aside class="td-lb-recent">
        <p class="td-lb-recent-title">Still cached — instant load</p>
        <div id="lbRecentWrap"><span class="td-lb-recent-empty">Loading…</span></div>
      </aside>
    </div>
  `;
}

function attachLoadOnClick(wrap, selector) {
  wrap.querySelectorAll(selector).forEach(el => {
    const go = () => loadCharacterById(el.dataset.characterId);
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
}

function renderLeaderboardTable(entries, wrap) {
  if (entries.length === 0) {
    wrap.innerHTML = `<p class="td-roster-note">Nobody's been looked up yet — search a character to be the first one on the board.</p>`;
    return;
  }
  const rows = entries.map((e, i) => `
    <tr class="td-roster-row" data-character-id="${esc(e.character_id)}" tabindex="0">
      <td>${i + 1}</td>
      <td>${esc(e.name)}</td>
      <td>${esc(WORLD_NAMES[e.world_id] || `World #${e.world_id}`)}</td>
      <td>${fmt(e.skill_points)}</td>
    </tr>
  `).join("");
  wrap.innerHTML = `
    <table class="td-roster-table">
      <thead><tr><th>#</th><th>Character</th><th>Server</th><th>Skill Points</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  attachLoadOnClick(wrap, ".td-roster-row");
}

function renderRecentList(entries, wrap) {
  if (entries.length === 0) {
    wrap.innerHTML = `<span class="td-lb-recent-empty">Nothing cached right now.</span>`;
    return;
  }
  wrap.innerHTML = entries.map(e => `
    <div class="td-lb-recent-item" data-character-id="${esc(e.character_id)}" tabindex="0">
      <span class="td-lb-recent-name">${esc(e.name)}</span>
      <span class="td-lb-recent-sp">${fmt(e.skill_points)} SP</span>
    </div>
  `).join("");
  attachLoadOnClick(wrap, ".td-lb-recent-item");
}

// Bumped on every call so a slow, superseded fetch (e.g. the tab got
// clicked twice in a row) can't win a race and repaint over a newer one.
let lbLoadToken = 0;
async function loadLeaderboardData() {
  const token = ++lbLoadToken;
  const tableWrap = document.getElementById("lbTableWrap");
  const recentWrap = document.getElementById("lbRecentWrap");
  tableWrap.innerHTML = `<div class="td-loading" style="height:240px;"></div>`;
  recentWrap.innerHTML = `<span class="td-lb-recent-empty">Loading…</span>`;

  const [lbResult, recentResult] = await Promise.allSettled([
    fetch(`${WORKER_BASE}/leaderboard?stat=skill_points&limit=25`).then(r => r.json()),
    fetch(`${WORKER_BASE}/recent?limit=8`).then(r => r.json()),
  ]);
  if (token !== lbLoadToken) return; // a newer load has since taken over

  if (lbResult.status === "fulfilled" && Array.isArray(lbResult.value.entries)) {
    renderLeaderboardTable(lbResult.value.entries, tableWrap);
  } else {
    tableWrap.innerHTML = `<p class="td-roster-note">Couldn't load the leaderboard right now. Please try again in a minute.</p>`;
  }

  if (recentResult.status === "fulfilled" && Array.isArray(recentResult.value.entries)) {
    renderRecentList(recentResult.value.entries, recentWrap);
  } else {
    recentWrap.innerHTML = `<span class="td-lb-recent-empty">Unavailable right now.</span>`;
  }
}

function initLeaderboard() {
  buildLeaderboardSkeleton();
}
initLeaderboard();

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
