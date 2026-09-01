// ---------------------------------------------------------------------
// Zindigon ToonData — Census API client
// Docs: https://census.daybreakgames.com/
// ---------------------------------------------------------------------

// swap for your approved service ID once Daybreak confirms it (see README)
const SERVICE_ID = "s:example";
const CENSUS_BASE = "https://census.daybreakgames.com";
const NAMESPACE = "dcuo:v1";
const PAGE_SIZE = 500;   // Census times out on much larger c:limit values for feat collections
const MAX_PAGES = 20;    // safety cap: 20 * 500 = 10,000 rows
const MAX_RETRIES = 3;

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
  constructor() { super("Rate limited by Census (10 requests/minute on s:example). Please wait a minute and try again."); }
}
class AuthWallError extends Error {
  constructor(collection) { super(`Collection '${collection}' requires OAuth login and can't be read with a service ID.`); }
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
const worldInput = document.getElementById("worldId");

function setStatus(message, type) {
  statusEl.textContent = message;
  statusEl.className = `status show ${type || "info"}`;
}
function clearStatus() {
  statusEl.className = "status";
  statusEl.textContent = "";
}
function clearMatches() {
  matchListEl.innerHTML = "";
}
function clearResult() {
  resultEl.className = "result";
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
  setStatus("Looking up character...", "info");
  searchBtn.disabled = true;

  try {
    const charParams = { name };
    if (worldId) charParams.world_id = worldId;

    const charJson = await censusGet("character", charParams);
    const matches = charJson.character_list || [];

    if (matches.length === 0) {
      setStatus(`No character named "${name}"${worldId ? ` on world_id ${worldId}` : ""} was found.`, "error");
      return;
    }

    if (matches.length > 1) {
      setStatus(`Multiple characters named "${name}" exist across different worlds. Pick one:`, "warn");
      matchListEl.innerHTML = matches.map(m => `
        <div class="match-item" data-character-id="${esc(m.character_id)}" data-world-id="${esc(m.world_id)}">
          <span>${esc(m.name)} — Level ${esc(m.level)}, CR ${esc(m.combat_rating)}</span>
          <span>World ID ${esc(m.world_id)}</span>
        </div>
      `).join("");
      [...matchListEl.children].forEach(el => {
        el.addEventListener("click", () => {
          nameInput.value = name;
          worldInput.value = el.dataset.worldId;
          runSearch(name, el.dataset.worldId);
        });
      });
      return;
    }

    const character = matches[0];
    const characterId = character.character_id;

    setStatus("Fetching equipped gear...", "info");
    const itemsJson = await censusGet("characters_item", { character_id: characterId, "c:limit": 500 });
    const equippedItems = (itemsJson.characters_item_list || [])
      .sort((a, b) => Number(a.equipment_slot_id) - Number(b.equipment_slot_id));

    setStatus("Fetching completed feats (this can take a few requests for veteran characters)...", "info");
    const completedFeats = await fetchAllPages("characters_completed_feat", { character_id: characterId });

    setStatus("Fetching in-progress feats...", "info");
    const activeFeats = await fetchAllPages("characters_active_feat", { character_id: characterId });

    setStatus("Fetching league info...", "info");
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
      league = { error: e.message };
    }

    clearStatus();
    renderCharacter(character, equippedItems, completedFeats, activeFeats, league);

  } catch (err) {
    if (err instanceof RateLimitError) {
      setStatus(err.message, "error");
    } else if (err instanceof AuthWallError) {
      setStatus(err.message, "error");
    } else {
      setStatus(`Something went wrong: ${err.message}`, "error");
    }
  } finally {
    searchBtn.disabled = false;
  }
}

function renderCharacter(c, items, completedFeats, activeFeats, league) {
  const statBlock = (label, value) => `
    <div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>
  `;

  const itemRows = items.map(it => `
    <tr>
      <td>${esc(it.equipment_slot_id)}</td>
      <td>${esc(it.item_id)}</td>
      <td>${it.is_bound === "true" ? "Yes" : "No"}</td>
      <td>${[it.aug_item_id_1, it.aug_item_id_2, it.aug_item_id_3].filter(v => v && v !== "-1").join(", ") || "—"}</td>
    </tr>
  `).join("");

  const featIdSpans = (list) => list.map(f => `<span>#${esc(f.feat_id)}</span>`).join("");

  const leagueHtml = league
    ? (league.error
        ? `<p class="limitations">League lookup failed: ${esc(league.error)}</p>`
        : `<div class="stat-grid">
             ${statBlock("League", league.name || "Unknown")}
             ${statBlock("Your Rank", league.rank)}
             ${statBlock("Guild ID", league.guild_id)}
           </div>`)
    : `<p class="limitations">This character is not in a league, or league data wasn't available.</p>`;

  resultEl.innerHTML = `
    <div class="card">
      <div class="char-header">
        <div class="name">${esc(c.name)}</div>
        <div class="meta">World ID ${esc(c.world_id)} &middot; Character ID ${esc(c.character_id)}</div>
      </div>
      <div class="stat-grid">
        ${statBlock("Level", c.level)}
        ${statBlock("Combat Rating", c.combat_rating)}
        ${statBlock("PvP CR", c.pvp_combat_rating)}
        ${statBlock("Skill Points", c.skill_points)}
        ${statBlock("Max Feat Points", c.max_feats)}
        ${statBlock("Health", `${c.current_health} / ${c.max_health}`)}
        ${statBlock("Power", `${c.current_power} / ${c.max_power}`)}
        ${statBlock("Might", c.might)}
        ${statBlock("Precision", c.precision)}
        ${statBlock("Restoration", c.restoration)}
        ${statBlock("Vitalization", c.vitalization)}
        ${statBlock("Dominance", c.dominance)}
        ${statBlock("Defense", c.defense)}
        ${statBlock("Toughness", c.toughness)}
        ${statBlock("Power Type ID", c.power_type_id)}
        ${statBlock("Power Source ID", c.power_source_id)}
        ${statBlock("Movement Mode ID", c.movement_mode_id)}
        ${statBlock("Alignment ID", c.alignment_id)}
        ${statBlock("Gender ID", c.gender_id)}
        ${statBlock("Origin ID", c.origin_id)}
        ${statBlock("Title ID", c.title_id)}
        ${statBlock("Personality ID", c.personality_id)}
        ${statBlock("Region ID", c.region_id)}
        ${statBlock("Active", c.active === "true" ? "Yes" : "No")}
      </div>
    </div>

    <div class="card">
      <h2>Equipped Gear (${items.length} items)</h2>
      <table>
        <thead><tr><th>Slot ID</th><th>Item ID</th><th>Bound</th><th>Mods</th></tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
    </div>

    <div class="card">
      <h2>Feats</h2>
      <div class="feat-summary">
        <div class="stat"><div class="label">Completed</div><div class="value">${completedFeats.length}</div></div>
        <div class="stat"><div class="label">In Progress</div><div class="value">${activeFeats.length}</div></div>
      </div>
      <details>
        <summary>Show completed feat IDs (${completedFeats.length})</summary>
        <div class="feat-id-list">${featIdSpans(completedFeats)}</div>
      </details>
      <details>
        <summary>Show in-progress feat IDs (${activeFeats.length})</summary>
        <div class="feat-id-list">${featIdSpans(activeFeats)}</div>
      </details>
    </div>

    <div class="card">
      <h2>League</h2>
      ${leagueHtml}
    </div>

    <div class="card">
      <h2>About this data</h2>
      <ul class="limitations">
        <li>Item and feat IDs are shown raw — the Census API exposes no name/reference lookup for items, feats, powers, or movement modes for DCUO.</li>
        <li>In-progress feats show only that they've been started, not a numeric progress amount.</li>
        <li>Completed feats have no completion date attached.</li>
        <li>House items and anything under the "auth_" collections require the character owner to log in via OAuth and aren't reachable here.</li>
        <li>Artifacts, allies, currencies, general inventory, daily mission completion, raid history, and scoreboard damage are not exposed by this API at all.</li>
      </ul>
    </div>
  `;
  resultEl.className = "result show";
}

// ---------------------------------------------------------------------
// Wire up UI
// ---------------------------------------------------------------------
searchBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  const worldId = worldInput.value.trim();
  if (!name) {
    setStatus("Enter a character name first.", "error");
    return;
  }
  runSearch(name, worldId);
});

nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") searchBtn.click(); });
worldInput.addEventListener("keydown", (e) => { if (e.key === "Enter") searchBtn.click(); });
