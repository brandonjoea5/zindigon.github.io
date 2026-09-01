// Zindigon ToonData | Census API client
// Docs: https://census.daybreakgames.com/

// swap for the approved service ID once Daybreak confirms it
const SERVICE_ID = "s:example";
const CENSUS_BASE = "https://census.daybreakgames.com";
const NAMESPACE = "dcuo:v1";
const PAGE_SIZE = 500;   // Census times out on much larger c:limit values for feat collections
const MAX_PAGES = 20;    // safety cap: 20 * 500 = 10,000 rows
const MAX_RETRIES = 3;

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
  "2": "US PC/PS",
};
// Confirmed by cross-checking gender_id against character names strongly
// associated with one gender (Batman/Superman-themed vs. Wonder
// Woman/Supergirl-themed) — same method used for alignment_id.
const GENDER_NAMES = {
  "0": "Male",
  "1": "Female",
};

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

// ---------------------------------------------------------------------
// Main search flow
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

    const character = matches[0];
    const characterId = character.character_id;

    setStatus("Fetching gear...");
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

  } catch (err) {
    setStatus(err.message || "Something went wrong. Please try again.", "error");
  } finally {
    searchBtn.disabled = false;
  }
}

function renderCharacter(c, items, completedFeats, activeFeats, league) {
  const kv = (label, value) => `<div><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div></div>`;
  const row = (label, value) => `<div class="td-row"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`;
  const fmt = (n) => Number(n).toLocaleString();

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

  // alignment_id isn't documented by Daybreak, but it only ever takes two
  // values and cross-checking name patterns (Batman/Superman-themed names
  // vs. Joker/Harley Quinn-themed names) confirms which is which.
  const ALIGNMENT_NAMES = { "2330": "Hero", "2331": "Villain" };
  const roleLabel = ALIGNMENT_NAMES[c.alignment_id] || null;

  const leagueName = league && league.name ? esc(league.name) : "None";

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
          <span class="td-tag">League <strong>${leagueName}</strong></span>
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
