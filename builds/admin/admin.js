// Zindigon Builds | Admin app.
// Single-page, rebuilt-per-view pattern (same approach as ToonData's
// app.js): each view function builds a full innerHTML string and wires
// delegated listeners on a stable container, so nothing needs "already
// wired" guards. Requires builds-shared.js loaded first (sb, esc, slugify,
// BuildsAuth, fetchReferenceData, rolesForPower all come from there).

const appEl = document.getElementById("appRoot");
const toastEl = document.getElementById("toast");

let ref = null;          // cached reference data (powers, roles, artifacts, ...)
let buildsCache = [];    // admin's full build list (all statuses)
let currentTab = "builds"; // 'builds' | 'reference'
let refTab = "powers";

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------
let toastTimer = null;
function toast(message, type) {
  toastEl.textContent = message;
  toastEl.className = `ba-toast show ${type || ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.className = "ba-toast"; }, 4000);
}

// ---------------------------------------------------------------------
// Boot / auth gate
// ---------------------------------------------------------------------
async function boot() {
  renderGateLoading();
  await BuildsAuth.init();
  BuildsAuth.onChange(() => route());
  await route();
}

async function route() {
  if (!BuildsAuth.isSignedIn()) return renderSignIn();
  if (!BuildsAuth.isAdmin()) return renderNotAdmin();
  if (!ref) {
    try { ref = await fetchReferenceData(); }
    catch (err) { return renderFatal(err.message); }
  }
  await loadBuilds();
  renderDashboard();
}

function renderGateLoading() {
  appEl.innerHTML = `
    <div class="center-shell">
      <div class="auth-card">
        <p class="mono muted">Loading Builds Admin…</p>
      </div>
    </div>
  `;
}

function renderFatal(message) {
  appEl.innerHTML = `
    <div class="center-shell">
      <div class="auth-card">
        <h1>Something went wrong</h1>
        <p>${esc(message)}</p>
        <div class="auth-status error">Reload the page to try again.</div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------
// Sign-in gate (reuses the site's .auth-card / .form pattern)
// ---------------------------------------------------------------------
function renderSignIn() {
  appEl.innerHTML = `
    <div class="center-shell">
      <div class="auth-card">
        <span class="eyebrow"><span class="dot"></span>Zindigon Studios Account</span>
        <h1>Builds Admin</h1>
        <p>Sign in with your Zindigon Studios account — the same one used for Elemental Rift.</p>
        <form class="form" id="signInForm" style="margin-top:20px;">
          <div class="field">
            <label for="siEmail">Email</label>
            <input class="input" id="siEmail" type="email" placeholder="your@email.com" autocomplete="username" required />
          </div>
          <div class="field">
            <label for="siPassword">Password</label>
            <input class="input" id="siPassword" type="password" placeholder="Password" autocomplete="current-password" required />
          </div>
          <button class="btn btn-primary" type="submit">Sign In</button>
        </form>
        <div class="auth-status" id="siStatus"></div>
      </div>
    </div>
  `;
  const form = document.getElementById("signInForm");
  const statusEl = document.getElementById("siStatus");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    statusEl.className = "auth-status";
    statusEl.textContent = "Signing in…";
    try {
      await BuildsAuth.signInWithPassword(
        document.getElementById("siEmail").value.trim(),
        document.getElementById("siPassword").value
      );
      statusEl.className = "auth-status ok";
      statusEl.textContent = "Signed in.";
      await route();
    } catch (err) {
      statusEl.className = "auth-status error";
      statusEl.textContent = err.message || "Sign in failed.";
    }
  });
}

function renderNotAdmin() {
  appEl.innerHTML = `
    <div class="center-shell">
      <div class="auth-card">
        <span class="eyebrow"><span class="dot"></span>Zindigon Studios Account</span>
        <h1>Not Authorized</h1>
        <p>You're signed in as <strong>${esc(BuildsAuth.session.user.email)}</strong>, but this account doesn't have Builds Admin access.</p>
        <div class="row" style="margin-top:20px;">
          <button class="btn btn-secondary" id="signOutBtn">Sign Out</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("signOutBtn").addEventListener("click", async () => {
    await BuildsAuth.signOut();
    await route();
  });
}

// ---------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------
async function loadBuilds() {
  const { data, error } = await sb
    .from("builds")
    .select("*")
    .order("updated_at", { ascending: false });
  if (error) { toast("Failed to load builds: " + error.message, "error"); buildsCache = []; return; }
  buildsCache = data;
}

function refName(list, id) {
  const row = list.find((r) => r.id === id);
  return row ? row.name : "—";
}

// ---------------------------------------------------------------------
// Dashboard shell
// ---------------------------------------------------------------------
function renderDashboard() {
  appEl.innerHTML = `
    <header class="site-header">
      <nav class="nav">
        <a class="brand" href="https://zindigon.com/">
          <span class="brand-mark"><svg viewBox="0 0 16 16"><path d="M2 3 L14 3 L2 13 L14 13"></path></svg></span>
          <span class="brand-name">Zindigon<em>studio</em></span>
        </a>
        <div class="ba-authbar">
          <span class="ba-admin-chip">Admin</span>
          <span><strong>${esc(BuildsAuth.player.username || BuildsAuth.session.user.email)}</strong></span>
          <button class="btn btn-ghost" id="signOutBtn" type="button">Sign Out</button>
        </div>
      </nav>
    </header>
    <main>
      <div class="section-head">
        <div>
          <span class="label">Zindigon Builds</span>
          <h2>Admin</h2>
        </div>
        <a class="link-arrow" href="../index.html">View public Builds page →</a>
      </div>

      <div class="ba-tabs">
        <button class="ba-tab ${currentTab === "builds" ? "active" : ""}" data-tab="builds" type="button">Builds</button>
        <button class="ba-tab ${currentTab === "reference" ? "active" : ""}" data-tab="reference" type="button">Reference Data</button>
      </div>

      <div id="tabBody"></div>
    </main>
    <div class="ba-toast" id="toast"></div>
  `;
  document.getElementById("signOutBtn").addEventListener("click", async () => {
    await BuildsAuth.signOut();
    await route();
  });
  appEl.querySelectorAll(".ba-tab").forEach((btn) => {
    btn.addEventListener("click", () => { currentTab = btn.dataset.tab; renderDashboard(); });
  });
  if (currentTab === "builds") renderBuildsList();
  else renderReferenceTab();
}

// =======================================================================
// BUILDS LIST
// =======================================================================
function renderBuildsList() {
  const body = document.getElementById("tabBody");
  body.innerHTML = `
    <div class="ba-list-head">
      <span class="mono muted">${buildsCache.length} build${buildsCache.length === 1 ? "" : "s"}</span>
      <div class="spacer"></div>
      <button class="btn btn-primary" id="newBuildBtn" type="button">+ New Build</button>
    </div>
    ${buildsCache.length === 0 ? `<div class="ba-empty">No builds yet — click "New Build" to document your first one.</div>` : `
    <div class="ba-table-wrap">
      <table class="ba-table">
        <thead><tr>
          <th>Name</th><th>Power</th><th>Role</th><th>Type</th><th>Status</th><th>Updated</th><th></th>
        </tr></thead>
        <tbody>
          ${buildsCache.map((b) => `
            <tr data-id="${esc(b.id)}">
              <td class="name">${esc(b.name)}</td>
              <td>${esc(refName(ref.powers, b.power_id))}</td>
              <td>${esc(refName(ref.roles, b.role_id))}</td>
              <td>${esc(refName(ref.buildTypes, b.build_type_id))}</td>
              <td><span class="ba-status ${esc(b.status)}">${esc(b.status)}</span></td>
              <td class="muted">${b.updated_at ? new Date(b.updated_at).toLocaleDateString() : "—"}</td>
              <td>
                <div class="ba-row-actions">
                  <button data-act="edit">Edit</button>
                  <button data-act="duplicate">Duplicate</button>
                  ${b.status === "published"
                    ? `<button data-act="unpublish">Unpublish</button>`
                    : `<button data-act="publish" class="accent">Publish</button>`}
                  ${b.status !== "archived" ? `<button data-act="archive">Archive</button>` : ""}
                  <button data-act="delete" class="danger">Delete</button>
                </div>
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
    `}
  `;

  document.getElementById("newBuildBtn").addEventListener("click", () => renderBuildForm(null));

  body.querySelectorAll("tr[data-id]").forEach((row) => {
    const id = row.dataset.id;
    row.querySelectorAll("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => handleRowAction(btn.dataset.act, id));
    });
  });
}

async function handleRowAction(action, id) {
  const build = buildsCache.find((b) => b.id === id);
  if (!build) return;

  if (action === "edit") return renderBuildForm(id);

  if (action === "duplicate") return duplicateBuild(id);

  if (action === "publish" || action === "unpublish" || action === "archive") {
    const status = action === "publish" ? "published" : action === "unpublish" ? "draft" : "archived";
    const { error } = await sb.from("builds").update({ status, updated_at: new Date().toISOString() }).eq("id", id);
    if (error) return toast("Failed: " + error.message, "error");
    toast(`"${build.name}" is now ${status}.`, "ok");
    await loadBuilds();
    renderBuildsList();
    return;
  }

  if (action === "delete") {
    if (!confirm(`Delete "${build.name}" permanently? This also removes its votes and comments. This cannot be undone.`)) return;
    const { error } = await sb.from("builds").delete().eq("id", id);
    if (error) return toast("Failed: " + error.message, "error");
    toast(`Deleted "${build.name}".`, "ok");
    await loadBuilds();
    renderBuildsList();
  }
}

async function duplicateBuild(id) {
  try {
    const [{ data: build, error: bErr }, loadout, artifacts, requirements, alternatives] = await Promise.all([
      sb.from("builds").select("*").eq("id", id).single(),
      sb.from("build_loadout_slots").select("*").eq("build_id", id),
      sb.from("build_artifacts").select("*").eq("build_id", id),
      sb.from("build_requirements").select("*").eq("build_id", id),
      sb.from("build_alternatives").select("*").eq("build_id", id),
    ]);
    if (bErr) throw bErr;

    let newSlug = build.slug + "-copy";
    if (buildsCache.some((b) => b.slug === newSlug)) newSlug += "-" + Date.now().toString(36).slice(-4);

    const { id: _id, created_at, updated_at, ...rest } = build;
    const { data: inserted, error: insErr } = await sb.from("builds").insert({
      ...rest,
      name: build.name + " (Copy)",
      slug: newSlug,
      status: "draft",
      created_by: BuildsAuth.session.user.id,
    }).select().single();
    if (insErr) throw insErr;

    await copyChildRows(inserted.id, loadout.data, artifacts.data, requirements.data, alternatives.data);

    toast(`Duplicated as "${inserted.name}" (draft).`, "ok");
    await loadBuilds();
    renderBuildForm(inserted.id);
  } catch (err) {
    toast("Duplicate failed: " + err.message, "error");
  }
}

async function copyChildRows(newBuildId, loadout, artifacts, requirements, alternatives) {
  const strip = (rows) => (rows || []).map(({ id, build_id, ...rest }) => ({ ...rest, build_id: newBuildId }));
  const inserts = [];
  const loadoutRows = strip(loadout);
  const artifactRows = strip(artifacts);
  const requirementRows = strip(requirements);
  const alternativeRows = strip(alternatives);
  if (loadoutRows.length) inserts.push(sb.from("build_loadout_slots").insert(loadoutRows));
  if (artifactRows.length) inserts.push(sb.from("build_artifacts").insert(artifactRows));
  if (requirementRows.length) inserts.push(sb.from("build_requirements").insert(requirementRows));
  if (alternativeRows.length) inserts.push(sb.from("build_alternatives").insert(alternativeRows));
  const results = await Promise.all(inserts);
  const failed = results.find((r) => r.error);
  if (failed) throw failed.error;
}

// =======================================================================
// BUILD FORM (create + edit share this)
// =======================================================================
let formChildren = { loadout: [], artifacts: [], requirements: [], alternatives: [] };

async function renderBuildForm(buildId) {
  const body = document.getElementById("tabBody");
  let build = null;
  if (buildId) {
    build = buildsCache.find((b) => b.id === buildId);
    const [loadout, artifacts, requirements, alternatives] = await Promise.all([
      sb.from("build_loadout_slots").select("*").eq("build_id", buildId).order("slot_number"),
      sb.from("build_artifacts").select("*").eq("build_id", buildId),
      sb.from("build_requirements").select("*").eq("build_id", buildId),
      sb.from("build_alternatives").select("*").eq("build_id", buildId),
    ]);
    formChildren = {
      loadout: loadout.data || [],
      artifacts: artifacts.data || [],
      requirements: requirements.data || [],
      alternatives: alternatives.data || [],
    };
  } else {
    formChildren = { loadout: [], artifacts: [], requirements: [], alternatives: [] };
  }

  const slotAt = (n) => formChildren.loadout.find((s) => s.slot_number === n);

  body.innerHTML = `
    <div class="section-head">
      <div><span class="label">${build ? "Editing" : "New Build"}</span><h2>${build ? esc(build.name) : "New Build"}</h2></div>
      <button class="btn btn-ghost" id="cancelFormBtn" type="button">← Back to list</button>
    </div>

    <form id="buildForm">
      <div class="ba-form-section">
        <h3>Basic Information</h3>
        <p class="hint">Slug is used in the build's permanent URL — auto-filled from the name, editable.</p>
        <div class="form">
          <div class="ba-grid-2">
            <div class="field"><label for="bfName">Build Name</label>
              <input class="input" id="bfName" required value="${esc(build?.name || "")}" /></div>
            <div class="field"><label for="bfSlug">Slug</label>
              <input class="input" id="bfSlug" required value="${esc(build?.slug || "")}" /></div>
          </div>
          <div class="ba-grid-3">
            <div class="field"><label for="bfPower">Power</label>
              <select class="select" id="bfPower">${ref.powers.map((p) => `<option value="${p.id}" ${build?.power_id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></div>
            <div class="field"><label for="bfRole">Role</label>
              <select class="select" id="bfRole"></select></div>
            <div class="field"><label for="bfBuildType">Build Type</label>
              <select class="select" id="bfBuildType">${ref.buildTypes.map((t) => `<option value="${t.id}" ${build?.build_type_id === t.id ? "selected" : ""}>${esc(t.name)}</option>`).join("")}</select></div>
          </div>
          <div class="ba-grid-3">
            <div class="field"><label for="bfContentType">Content Type</label>
              <select class="select" id="bfContentType"><option value="">—</option>${ref.contentTypes.map((c) => `<option value="${c.id}" ${build?.content_type_id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</select></div>
            <div class="field"><label for="bfDifficulty">Difficulty</label>
              <select class="select" id="bfDifficulty">
                ${["beginner", "intermediate", "advanced"].map((d) => `<option value="${d}" ${(build?.difficulty || "intermediate") === d ? "selected" : ""}>${d[0].toUpperCase() + d.slice(1)}</option>`).join("")}
              </select></div>
            <div class="field"><label for="bfStatus">Status</label>
              <select class="select" id="bfStatus">
                ${["draft", "published", "archived"].map((s) => `<option value="${s}" ${(build?.status || "draft") === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}
              </select></div>
          </div>
          <div class="field"><label for="bfRecommendedFor">Recommended For (comma-separated)</label>
            <input class="input" id="bfRecommendedFor" placeholder="Raids, Elite, Bosses" value="${esc((build?.recommended_for || []).join(", "))}" /></div>
          <div class="field"><label for="bfShortDesc">Short Description</label>
            <textarea class="textarea" id="bfShortDesc" style="min-height:70px;">${esc(build?.short_description || "")}</textarea></div>
        </div>
      </div>

      <div class="ba-form-section">
        <h3>Loadout</h3>
        <p class="hint">Both ability trays, six slots each, in order.</p>
        ${[1, 2].map((tray) => `
          <div class="ba-tray-label">Tray ${tray}</div>
          ${[1, 2, 3, 4, 5, 6].map((n) => {
            const slotNumber = tray === 1 ? n : n + 6;
            return `
          <div class="ba-loadout-slot">
            <span class="num">${n}.</span>
            <input class="input" data-loadout-name="${slotNumber}" placeholder="Ability name" value="${esc(slotAt(slotNumber)?.ability_name || "")}" />
            <input class="input" data-loadout-notes="${slotNumber}" placeholder="Notes (optional)" value="${esc(slotAt(slotNumber)?.notes || "")}" />
          </div>`;
          }).join("")}
        `).join("")}
      </div>

      <div class="ba-form-section">
        <h3>Artifacts</h3>
        <p class="hint">Primary setup plus alternates. Importance and rank drive the matcher's scoring.</p>
        <div id="artifactRows"></div>
        <button type="button" class="btn btn-secondary ba-add-row" id="addArtifactRow">+ Add Artifact</button>
      </div>

      <div class="ba-form-section">
        <h3>Requirements</h3>
        <p class="hint">Movement, iconics, power arrays, or anything else this build needs.</p>
        <div id="requirementRows"></div>
        <button type="button" class="btn btn-secondary ba-add-row" id="addRequirementRow">+ Add Requirement</button>
      </div>

      <div class="ba-form-section">
        <h3>Situational Swaps &amp; Alternatives</h3>
        <p class="hint">e.g. "Replace X with Y for Single Target."</p>
        <div id="alternativeRows"></div>
        <button type="button" class="btn btn-secondary ba-add-row" id="addAlternativeRow">+ Add Swap</button>
      </div>

      <div class="ba-form-section">
        <h3>Write-up</h3>
        <div class="form">
          <div class="field"><label for="bfWhyWorks">Why This Build Works</label>
            <textarea class="textarea" id="bfWhyWorks">${esc(build?.why_it_works || "")}</textarea></div>
          <div class="field"><label for="bfRotation">Rotation</label>
            <textarea class="textarea" id="bfRotation">${esc(build?.rotation || "")}</textarea></div>
          <div class="ba-grid-2">
            <div class="field"><label for="bfStrengths">Strengths</label>
              <textarea class="textarea" id="bfStrengths" style="min-height:100px;">${esc(build?.strengths || "")}</textarea></div>
            <div class="field"><label for="bfWeaknesses">Weaknesses</label>
              <textarea class="textarea" id="bfWeaknesses" style="min-height:100px;">${esc(build?.weaknesses || "")}</textarea></div>
          </div>
          <div class="field"><label for="bfNotes">Notes</label>
            <textarea class="textarea" id="bfNotes" style="min-height:80px;">${esc(build?.notes || "")}</textarea></div>
          <div class="field"><label for="bfLastTested">Last Tested Date</label>
            <input class="input" type="date" id="bfLastTested" style="max-width:220px;" value="${build?.last_tested_date || ""}" /></div>
        </div>
      </div>

      <div class="ba-form-actions">
        <button type="submit" class="btn btn-primary" id="saveBuildBtn">Save Build</button>
        <button type="button" class="btn btn-ghost" id="cancelFormBtn2">Cancel</button>
      </div>
    </form>
  `;

  populateRoleSelect(build?.role_id);
  document.getElementById("bfPower").addEventListener("change", () => populateRoleSelect());

  document.getElementById("bfName").addEventListener("blur", () => {
    const slugEl = document.getElementById("bfSlug");
    if (!slugEl.value.trim()) slugEl.value = slugify(document.getElementById("bfName").value);
  });

  ["cancelFormBtn", "cancelFormBtn2"].forEach((id) =>
    document.getElementById(id).addEventListener("click", () => renderBuildsList())
  );

  formChildren.artifacts.forEach((row) => addArtifactRow(row));
  formChildren.requirements.forEach((row) => addRequirementRow(row));
  formChildren.alternatives.forEach((row) => addAlternativeRow(row));
  document.getElementById("addArtifactRow").addEventListener("click", () => addArtifactRow());
  document.getElementById("addRequirementRow").addEventListener("click", () => addRequirementRow());
  document.getElementById("addAlternativeRow").addEventListener("click", () => addAlternativeRow());

  document.getElementById("buildForm").addEventListener("submit", (e) => {
    e.preventDefault();
    saveBuild(buildId);
  });
}

function populateRoleSelect(selectedRoleId) {
  const powerId = document.getElementById("bfPower").value;
  const roleSel = document.getElementById("bfRole");
  const roles = rolesForPower(ref, powerId);
  roleSel.innerHTML = roles.map((r) => `<option value="${r.id}" ${r.id === selectedRoleId ? "selected" : ""}>${esc(r.name)}</option>`).join("")
    || `<option value="">No roles configured for this power yet</option>`;
}

// --- Repeatable rows: rendered once per add, values read from the DOM on save ---
function addArtifactRow(existing) {
  const container = document.getElementById("artifactRows");
  const div = document.createElement("div");
  div.className = "ba-repeat-row";
  div.innerHTML = `
    <div class="field"><label>Artifact</label>
      <select class="select" data-f="artifact_id">${ref.artifacts.map((a) => `<option value="${a.id}" ${existing?.artifact_id === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></div>
    <div class="field"><label>Slot</label>
      <select class="select" data-f="slot_position">
        <option value="">Alt/Bench</option>
        ${[1, 2, 3].map((n) => `<option value="${n}" ${existing?.slot_position === n ? "selected" : ""}>${n}</option>`).join("")}
      </select></div>
    <div class="field"><label>Importance</label>
      <select class="select" data-f="importance">${importanceOptions(existing?.importance)}</select></div>
    <div class="field"><label>Min Rank</label>
      <input class="input" type="number" step="20" data-f="min_rank" value="${existing?.min_rank ?? 160}" /></div>
    <div class="field"><label>Notes</label>
      <input class="input" data-f="notes" value="${esc(existing?.notes || "")}" /></div>
    <button type="button" class="ba-repeat-remove" title="Remove">×</button>
  `;
  div.querySelector(".ba-repeat-remove").addEventListener("click", () => div.remove());
  container.appendChild(div);
}

const REQUIREMENT_TYPE_LABELS = {
  artifact: "Artifact", movement: "Movement", iconic_ability: "Iconic Ability",
  power_array: "Power Array", power_array_ability: "Power Array Ability", other: "Other",
};

function addRequirementRow(existing) {
  const container = document.getElementById("requirementRows");
  const div = document.createElement("div");
  div.className = "ba-repeat-row";
  const type = existing?.requirement_type || "artifact";
  div.innerHTML = `
    <div class="field"><label>Type</label>
      <select class="select" data-f="requirement_type">
        ${Object.entries(REQUIREMENT_TYPE_LABELS).map(([v, l]) => `<option value="${v}" ${type === v ? "selected" : ""}>${l}</option>`).join("")}
      </select></div>
    <div class="field" data-ref-field><label>Value</label>
      <select class="select" data-f="ref_value"></select></div>
    <div class="field"><label>Importance</label>
      <select class="select" data-f="importance">${importanceOptions(existing?.importance || "recommended")}</select></div>
    <div class="field"><label>Min Rank</label>
      <input class="input" type="number" step="20" data-f="min_rank" value="${existing?.min_rank ?? ""}" placeholder="—" /></div>
    <div class="field"><label>Notes</label>
      <input class="input" data-f="notes" value="${esc(existing?.notes || "")}" /></div>
    <button type="button" class="ba-repeat-remove" title="Remove">×</button>
  `;
  div.querySelector(".ba-repeat-remove").addEventListener("click", () => div.remove());
  const typeSel = div.querySelector('[data-f="requirement_type"]');
  const currentRefId = existing?.artifact_id || existing?.movement_mode_id || existing?.iconic_ability_id
    || existing?.power_array_id || existing?.power_array_ability_id || null;
  populateRequirementRefField(div, type, currentRefId, existing?.other_label);
  typeSel.addEventListener("change", () => populateRequirementRefField(div, typeSel.value));
  container.appendChild(div);
}

function populateRequirementRefField(rowEl, type, selectedId, otherText) {
  const fieldWrap = rowEl.querySelector("[data-ref-field]");
  if (type === "other") {
    fieldWrap.innerHTML = `<label>Description</label><input class="input" data-f="ref_value" data-other="true" value="${esc(otherText || "")}" placeholder="Free text" />`;
    return;
  }
  const options = {
    artifact: ref.artifacts,
    movement: ref.movementModes,
    iconic_ability: ref.iconicAbilities,
    power_array: ref.powerArrays,
    power_array_ability: ref.powerArrayAbilities.map((a) => ({ id: a.id, name: `${a.ability_name} (rank ${a.required_rank}+)` })),
  }[type] || [];
  fieldWrap.innerHTML = `<label>Value</label><select class="select" data-f="ref_value">${options.map((o) => `<option value="${o.id}" ${o.id === selectedId ? "selected" : ""}>${esc(o.name)}</option>`).join("") || `<option value="">Nothing configured yet</option>`}</select>`;
}

function addAlternativeRow(existing) {
  const container = document.getElementById("alternativeRows");
  const div = document.createElement("div");
  div.className = "ba-repeat-row";
  div.innerHTML = `
    <div class="field"><label>Situation (optional)</label>
      <input class="input" data-f="situation" value="${esc(existing?.situation || "")}" placeholder="Single Target" /></div>
    <div class="field"><label>Replace</label>
      <input class="input" data-f="replace_label" value="${esc(existing?.replace_label || "")}" required /></div>
    <div class="field"><label>With</label>
      <input class="input" data-f="with_label" value="${esc(existing?.with_label || "")}" required /></div>
    <div class="field"><label>Notes</label>
      <input class="input" data-f="notes" value="${esc(existing?.notes || "")}" /></div>
    <button type="button" class="ba-repeat-remove" title="Remove">×</button>
  `;
  div.querySelector(".ba-repeat-remove").addEventListener("click", () => div.remove());
  container.appendChild(div);
}

function importanceOptions(selected) {
  return ["required", "recommended", "optional"]
    .map((v) => `<option value="${v}" ${selected === v ? "selected" : ""}>${v[0].toUpperCase() + v.slice(1)}</option>`)
    .join("");
}

// --- Collect the form + repeatable rows into a save payload ---
function collectBuildPayload() {
  const val = (id) => document.getElementById(id).value;
  const recommendedFor = val("bfRecommendedFor").split(",").map((s) => s.trim()).filter(Boolean);

  const build = {
    name: val("bfName").trim(),
    slug: slugify(val("bfSlug")) || slugify(val("bfName")),
    power_id: val("bfPower"),
    role_id: val("bfRole"),
    build_type_id: val("bfBuildType"),
    content_type_id: val("bfContentType") || null,
    difficulty: val("bfDifficulty"),
    status: val("bfStatus"),
    short_description: val("bfShortDesc").trim() || null,
    recommended_for: recommendedFor,
    why_it_works: val("bfWhyWorks").trim() || null,
    rotation: val("bfRotation").trim() || null,
    strengths: val("bfStrengths").trim() || null,
    weaknesses: val("bfWeaknesses").trim() || null,
    notes: val("bfNotes").trim() || null,
    last_tested_date: val("bfLastTested") || null,
    updated_at: new Date().toISOString(),
  };

  const loadout = Array.from({ length: 12 }, (_, i) => i + 1).map((n) => ({
    slot_number: n,
    ability_name: document.querySelector(`[data-loadout-name="${n}"]`).value.trim(),
    notes: document.querySelector(`[data-loadout-notes="${n}"]`).value.trim() || null,
  })).filter((s) => s.ability_name); // skip genuinely empty slots (12 = 2 trays × 6)

  const artifacts = [...document.querySelectorAll("#artifactRows .ba-repeat-row")].map((row) => ({
    artifact_id: row.querySelector('[data-f="artifact_id"]').value,
    slot_position: row.querySelector('[data-f="slot_position"]').value || null,
    importance: row.querySelector('[data-f="importance"]').value,
    min_rank: Number(row.querySelector('[data-f="min_rank"]').value) || 160,
    notes: row.querySelector('[data-f="notes"]').value.trim() || null,
  }));

  const requirements = [...document.querySelectorAll("#requirementRows .ba-repeat-row")].map((row) => {
    const type = row.querySelector('[data-f="requirement_type"]').value;
    const refInput = row.querySelector('[data-f="ref_value"]');
    const refValue = refInput ? refInput.value : "";
    const base = {
      requirement_type: type,
      importance: row.querySelector('[data-f="importance"]').value,
      min_rank: row.querySelector('[data-f="min_rank"]').value ? Number(row.querySelector('[data-f="min_rank"]').value) : null,
      notes: row.querySelector('[data-f="notes"]').value.trim() || null,
      artifact_id: null, movement_mode_id: null, iconic_ability_id: null,
      power_array_id: null, power_array_ability_id: null, other_label: null,
    };
    if (type === "other") base.other_label = refValue.trim();
    else if (type === "artifact") base.artifact_id = refValue || null;
    else if (type === "movement") base.movement_mode_id = refValue || null;
    else if (type === "iconic_ability") base.iconic_ability_id = refValue || null;
    else if (type === "power_array") base.power_array_id = refValue || null;
    else if (type === "power_array_ability") base.power_array_ability_id = refValue || null;
    return base;
  }).filter((r) => r.other_label || r.artifact_id || r.movement_mode_id || r.iconic_ability_id || r.power_array_id || r.power_array_ability_id);

  const alternatives = [...document.querySelectorAll("#alternativeRows .ba-repeat-row")].map((row) => ({
    situation: row.querySelector('[data-f="situation"]').value.trim() || null,
    replace_label: row.querySelector('[data-f="replace_label"]').value.trim(),
    with_label: row.querySelector('[data-f="with_label"]').value.trim(),
    notes: row.querySelector('[data-f="notes"]').value.trim() || null,
  })).filter((a) => a.replace_label && a.with_label);

  return { build, loadout, artifacts, requirements, alternatives };
}

async function saveBuild(buildId) {
  const btn = document.getElementById("saveBuildBtn");
  btn.disabled = true;
  try {
    const { build, loadout, artifacts, requirements, alternatives } = collectBuildPayload();
    if (!build.name || !build.power_id || !build.role_id || !build.build_type_id) {
      toast("Name, Power, Role, and Build Type are required.", "error");
      btn.disabled = false;
      return;
    }

    let id = buildId;
    if (id) {
      const { error } = await sb.from("builds").update(build).eq("id", id);
      if (error) throw error;
    } else {
      const { data, error } = await sb.from("builds")
        .insert({ ...build, created_by: BuildsAuth.session.user.id })
        .select().single();
      if (error) throw error;
      id = data.id;
    }

    // Replace-all strategy for child rows: simplest correct approach for a
    // single-admin tool — delete then re-insert rather than diffing.
    await Promise.all([
      sb.from("build_loadout_slots").delete().eq("build_id", id),
      sb.from("build_artifacts").delete().eq("build_id", id),
      sb.from("build_requirements").delete().eq("build_id", id),
      sb.from("build_alternatives").delete().eq("build_id", id),
    ]);
    const reinserts = [];
    if (loadout.length) reinserts.push(sb.from("build_loadout_slots").insert(loadout.map((r) => ({ ...r, build_id: id }))));
    if (artifacts.length) reinserts.push(sb.from("build_artifacts").insert(artifacts.map((r) => ({ ...r, build_id: id }))));
    if (requirements.length) reinserts.push(sb.from("build_requirements").insert(requirements.map((r) => ({ ...r, build_id: id }))));
    if (alternatives.length) reinserts.push(sb.from("build_alternatives").insert(alternatives.map((r) => ({ ...r, build_id: id }))));
    const results = await Promise.all(reinserts);
    const failed = results.find((r) => r.error);
    if (failed) throw failed.error;

    toast(`Saved "${build.name}".`, "ok");
    await loadBuilds();
    renderBuildsList();
  } catch (err) {
    toast("Save failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
  }
}

// =======================================================================
// REFERENCE DATA TAB
// =======================================================================
const SIMPLE_REF_TABLES = {
  roles: { table: "roles", label: "Roles", key: "roles" },
  build_types: { table: "build_types", label: "Build Types", key: "buildTypes" },
  content_types: { table: "content_types", label: "Content Types", key: "contentTypes" },
  movement_modes: { table: "movement_modes", label: "Movement Modes", key: "movementModes" },
  iconic_abilities: { table: "iconic_abilities", label: "Iconic Abilities", key: "iconicAbilities" },
  artifacts: { table: "artifacts", label: "Artifacts", key: "artifacts" },
};

function renderReferenceTab() {
  const body = document.getElementById("tabBody");
  const refTabs = [
    ["powers", "Powers"], ["power_arrays", "Power Arrays"],
    ...Object.entries(SIMPLE_REF_TABLES).map(([k, v]) => [k, v.label]),
  ];
  body.innerHTML = `
    <div class="ba-ref-tabs">
      ${refTabs.map(([k, label]) => `<button data-reftab="${k}" class="${refTab === k ? "active" : ""}" type="button">${label}</button>`).join("")}
    </div>
    <div id="refBody"></div>
  `;
  body.querySelectorAll("[data-reftab]").forEach((btn) => {
    btn.addEventListener("click", () => { refTab = btn.dataset.reftab; renderReferenceTab(); });
  });

  if (refTab === "powers") renderPowersRef();
  else if (refTab === "power_arrays") renderPowerArraysRef();
  else renderSimpleRef(SIMPLE_REF_TABLES[refTab]);
}

function renderSimpleRef(cfg) {
  const refBody = document.getElementById("refBody");
  const rows = ref[cfg.key];
  refBody.innerHTML = `
    <div class="ba-form-section">
      <h3>${cfg.label}</h3>
      <div class="ba-ref-list">
        ${rows.length ? rows.map((r) => `
          <div class="ba-ref-item" data-id="${r.id}">
            <span class="name">${esc(r.name)}</span>
            <span class="slug">${esc(r.slug)}</span>
            <span class="spacer"></span>
            <button data-del>Remove</button>
          </div>
        `).join("") : `<div class="ba-repeat-empty">Nothing added yet.</div>`}
      </div>
      <form class="ba-ref-add-form" id="refAddForm">
        <div class="field"><label>Name</label><input class="input" id="refName" required /></div>
        <button class="btn btn-secondary" type="submit">+ Add</button>
      </form>
    </div>
  `;
  refBody.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest("[data-id]").dataset.id;
      if (!confirm("Remove this entry? Builds referencing it may break.")) return;
      const { error } = await sb.from(cfg.table).delete().eq("id", id);
      if (error) return toast("Failed: " + error.message, "error");
      ref = await fetchReferenceData();
      renderReferenceTab();
    });
  });
  document.getElementById("refAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("refName").value.trim();
    if (!name) return;
    const { error } = await sb.from(cfg.table).insert({ name, slug: slugify(name), sort_order: rows.length });
    if (error) return toast("Failed: " + error.message, "error");
    ref = await fetchReferenceData();
    toast(`Added "${name}".`, "ok");
    renderReferenceTab();
  });
}

function renderPowersRef() {
  const refBody = document.getElementById("refBody");
  refBody.innerHTML = `
    <div class="ba-form-section">
      <h3>Powers</h3>
      <p class="hint">Check which roles are valid for each power — this drives Step 1 &amp; 2 of Find My Build.</p>
      <div class="ba-ref-list">
        ${ref.powers.map((p) => {
          const validIds = new Set(ref.powerRoles.filter((pr) => pr.power_id === p.id).map((pr) => pr.role_id));
          return `
          <div class="ba-ref-item" data-id="${p.id}" style="flex-direction:column; align-items:stretch; gap:8px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <span class="name">${esc(p.name)}</span>
              <span class="slug">${esc(p.slug)}</span>
              <span class="spacer"></span>
              <button data-del>Remove</button>
            </div>
            <div class="ba-role-checks">
              ${ref.roles.map((r) => `
                <label><input type="checkbox" data-power-role="${p.id}:${r.id}" ${validIds.has(r.id) ? "checked" : ""} /> ${esc(r.name)}</label>
              `).join("")}
            </div>
          </div>`;
        }).join("") || `<div class="ba-repeat-empty">No powers added yet.</div>`}
      </div>
      <form class="ba-ref-add-form" id="refAddForm">
        <div class="field"><label>Power Name</label><input class="input" id="refName" required /></div>
        <button class="btn btn-secondary" type="submit">+ Add Power</button>
      </form>
    </div>
  `;
  refBody.querySelectorAll("[data-del]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest("[data-id]").dataset.id;
      if (!confirm("Remove this power? Builds referencing it may break.")) return;
      const { error } = await sb.from("powers").delete().eq("id", id);
      if (error) return toast("Failed: " + error.message, "error");
      ref = await fetchReferenceData();
      renderReferenceTab();
    });
  });
  refBody.querySelectorAll("[data-power-role]").forEach((cb) => {
    cb.addEventListener("change", async () => {
      const [powerId, roleId] = cb.dataset.powerRole.split(":");
      if (cb.checked) {
        const { error } = await sb.from("power_roles").insert({ power_id: powerId, role_id: roleId });
        if (error) { toast("Failed: " + error.message, "error"); cb.checked = false; return; }
      } else {
        const { error } = await sb.from("power_roles").delete().eq("power_id", powerId).eq("role_id", roleId);
        if (error) { toast("Failed: " + error.message, "error"); cb.checked = true; return; }
      }
      ref = await fetchReferenceData();
    });
  });
  document.getElementById("refAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("refName").value.trim();
    if (!name) return;
    const { error } = await sb.from("powers").insert({ name, slug: slugify(name), sort_order: ref.powers.length });
    if (error) return toast("Failed: " + error.message, "error");
    ref = await fetchReferenceData();
    toast(`Added "${name}".`, "ok");
    renderReferenceTab();
  });
}

function renderPowerArraysRef() {
  const refBody = document.getElementById("refBody");
  refBody.innerHTML = `
    <div class="ba-form-section">
      <h3>Power Arrays</h3>
      <p class="hint">Each array's unlocked abilities, with the rank required for each.</p>
      <div class="ba-ref-list">
        ${ref.powerArrays.map((pa) => {
          const abilities = ref.powerArrayAbilities.filter((a) => a.power_array_id === pa.id);
          return `
          <div class="ba-ref-item" data-id="${pa.id}" style="flex-direction:column; align-items:stretch; gap:8px;">
            <div style="display:flex; align-items:center; gap:12px;">
              <span class="name">${esc(pa.name)}</span>
              <span class="spacer"></span>
              <button data-del-array>Remove</button>
            </div>
            <div class="ba-ref-list" style="margin-top:0; padding-left:14px; border-left:2px solid var(--line);">
              ${abilities.map((a) => `
                <div class="ba-ref-item" data-ability-id="${a.id}">
                  <span class="name">${esc(a.ability_name)}</span>
                  <span class="slug">rank ${a.required_rank}+</span>
                  <span class="spacer"></span>
                  <button data-del-ability>Remove</button>
                </div>
              `).join("") || `<div class="ba-repeat-empty">No abilities yet.</div>`}
              <form class="ba-ref-add-form" data-add-ability="${pa.id}">
                <div class="field"><label>Ability</label><input class="input" data-ability-name required /></div>
                <div class="field" style="max-width:140px;"><label>Required Rank</label><input class="input" type="number" step="20" data-ability-rank value="1" /></div>
                <button class="btn btn-secondary" type="submit">+ Add Ability</button>
              </form>
            </div>
          </div>`;
        }).join("") || `<div class="ba-repeat-empty">No power arrays added yet.</div>`}
      </div>
      <form class="ba-ref-add-form" id="refAddForm">
        <div class="field"><label>Power Array Name</label><input class="input" id="refName" required /></div>
        <button class="btn btn-secondary" type="submit">+ Add Power Array</button>
      </form>
    </div>
  `;
  refBody.querySelectorAll("[data-del-array]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest("[data-id]").dataset.id;
      if (!confirm("Remove this power array and all its abilities?")) return;
      const { error } = await sb.from("power_arrays").delete().eq("id", id);
      if (error) return toast("Failed: " + error.message, "error");
      ref = await fetchReferenceData();
      renderReferenceTab();
    });
  });
  refBody.querySelectorAll("[data-del-ability]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.closest("[data-ability-id]").dataset.abilityId;
      const { error } = await sb.from("power_array_abilities").delete().eq("id", id);
      if (error) return toast("Failed: " + error.message, "error");
      ref = await fetchReferenceData();
      renderReferenceTab();
    });
  });
  refBody.querySelectorAll("[data-add-ability]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const powerArrayId = form.dataset.addAbility;
      const name = form.querySelector("[data-ability-name]").value.trim();
      const rank = Number(form.querySelector("[data-ability-rank]").value) || 1;
      if (!name) return;
      const { error } = await sb.from("power_array_abilities").insert({ power_array_id: powerArrayId, ability_name: name, required_rank: rank });
      if (error) return toast("Failed: " + error.message, "error");
      ref = await fetchReferenceData();
      renderReferenceTab();
    });
  });
  document.getElementById("refAddForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("refName").value.trim();
    if (!name) return;
    const { error } = await sb.from("power_arrays").insert({ name, slug: slugify(name) });
    if (error) return toast("Failed: " + error.message, "error");
    ref = await fetchReferenceData();
    toast(`Added "${name}".`, "ok");
    renderReferenceTab();
  });
}

boot();
