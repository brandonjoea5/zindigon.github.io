// Zindigon Builds | Public "Submit a Build" page.
// Signed-in users (with a profile) get the same build-authoring form the
// admin panel uses, adapted for a single always-draft submission: no Status
// field (forced to "draft"), no free-text "Submitted By" (taken from the
// signed-in profile's username), and no edit-existing-submission flow —
// this always creates one new build. Depends on builds-shared.js (sb, esc,
// slugify, BuildsAuth, fetchReferenceData, rolesForPower) and account.js
// (BuildsAuth UI + openAccountModal) being loaded first.

let ref = null;
let formLoaded = false;

async function boot() {
  await BuildsAuth.init();
  renderRoot();
  BuildsAuth.onChange(() => renderRoot());
}

function renderRoot() {
  const root = document.getElementById("submitRoot");
  if (!root) return;

  if (!BuildsAuth.isSignedIn()) {
    root.innerHTML = `
      <div class="bp-empty">
        <p class="bp-empty-title">Sign in to submit a build</p>
        <p>Create a free account (or sign in) to submit a build for review.</p>
        <button class="btn btn-primary" id="submitSignInBtn" type="button" style="margin-top:14px;">Sign In / Sign Up</button>
      </div>`;
    document.getElementById("submitSignInBtn").addEventListener("click", () => openAccountModal("signin"));
    return;
  }

  if (!BuildsAuth.hasProfile()) {
    root.innerHTML = `
      <div class="bp-empty">
        <p class="bp-empty-title">Finish setting up your account</p>
        <p>Choose a username above to continue — you'll be able to submit a build right after.</p>
      </div>`;
    return;
  }

  loadFormOnce();
}

async function loadFormOnce() {
  if (formLoaded) return;
  const root = document.getElementById("submitRoot");
  try {
    ref = await fetchReferenceData();
  } catch (err) {
    root.innerHTML = `<div class="bp-empty"><p class="bp-empty-title">Something went wrong</p><p>${esc(err.message)}</p></div>`;
    return;
  }
  formLoaded = true;
  renderForm();
}

function renderForm() {
  const root = document.getElementById("submitRoot");

  root.innerHTML = `
    <form id="buildForm">
      <div class="ba-form-section">
        <h3>Basic Information</h3>
        <p class="hint">Slug is used in the build's permanent URL — auto-filled from the name, editable.</p>
        <div class="form">
          <div class="ba-grid-2">
            <div class="field"><label for="bfName">Build Name</label>
              <input class="input" id="bfName" required value="" /></div>
            <div class="field"><label for="bfSlug">Slug</label>
              <input class="input" id="bfSlug" required value="" /></div>
          </div>
          <div class="ba-grid-3">
            <div class="field"><label for="bfPower">Power</label>
              <select class="select" id="bfPower">${ref.powers.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("")}</select></div>
            <div class="field"><label for="bfRole">Role</label>
              <select class="select" id="bfRole"></select></div>
            <div class="field"><label for="bfBuildType">Build Type</label>
              <select class="select" id="bfBuildType">${ref.buildTypes.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></div>
          </div>
          <div class="ba-grid-3">
            <div class="field"><label for="bfContentType">Content Type</label>
              <select class="select" id="bfContentType"><option value="">—</option>${ref.contentTypes.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join("")}</select></div>
            <div class="field"><label for="bfDifficulty">Difficulty</label>
              <select class="select" id="bfDifficulty">
                ${["beginner", "intermediate", "advanced"].map((d) => `<option value="${d}" ${d === "intermediate" ? "selected" : ""}>${d[0].toUpperCase() + d.slice(1)}</option>`).join("")}
              </select></div>
            <div class="field"><label for="bfRecommendedFor">Recommended For (comma-separated)</label>
              <input class="input" id="bfRecommendedFor" placeholder="Raids, Elite, Bosses" value="" /></div>
          </div>
          <div class="field"><label for="bfShortDesc">Short Description</label>
            <textarea class="textarea" id="bfShortDesc" style="min-height:70px;"></textarea></div>
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
            <input class="input" data-loadout-name="${slotNumber}" placeholder="Ability name" value="" />
            <input class="input" data-loadout-notes="${slotNumber}" placeholder="Notes (optional)" value="" />
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
            <textarea class="textarea" id="bfWhyWorks"></textarea></div>
          <div class="field"><label for="bfRotation">Rotation</label>
            <textarea class="textarea" id="bfRotation"></textarea></div>
          <div class="ba-grid-2">
            <div class="field"><label for="bfStrengths">Strengths</label>
              <textarea class="textarea" id="bfStrengths" style="min-height:100px;"></textarea></div>
            <div class="field"><label for="bfWeaknesses">Weaknesses</label>
              <textarea class="textarea" id="bfWeaknesses" style="min-height:100px;"></textarea></div>
          </div>
          <div class="field"><label for="bfNotes">Notes</label>
            <textarea class="textarea" id="bfNotes" style="min-height:80px;"></textarea></div>
        </div>
      </div>

      <p class="bp-account-error" id="submitError" hidden></p>

      <div class="ba-form-actions">
        <button type="submit" class="btn btn-primary" id="submitBuildBtn">Submit for Review</button>
      </div>
    </form>
  `;

  populateRoleSelect();
  document.getElementById("bfPower").addEventListener("change", () => populateRoleSelect());

  document.getElementById("bfName").addEventListener("blur", () => {
    const slugEl = document.getElementById("bfSlug");
    if (!slugEl.value.trim()) slugEl.value = slugify(document.getElementById("bfName").value);
  });

  document.getElementById("addArtifactRow").addEventListener("click", () => addArtifactRow());
  document.getElementById("addRequirementRow").addEventListener("click", () => addRequirementRow());
  document.getElementById("addAlternativeRow").addEventListener("click", () => addAlternativeRow());

  document.getElementById("buildForm").addEventListener("submit", (e) => {
    e.preventDefault();
    submitBuild();
  });
}

function populateRoleSelect() {
  const powerId = document.getElementById("bfPower").value;
  const roleSel = document.getElementById("bfRole");
  const roles = rolesForPower(ref, powerId);
  roleSel.innerHTML = roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("")
    || `<option value="">No roles configured for this power yet</option>`;
}

function importanceOptions(selected) {
  return ["required", "recommended", "optional"]
    .map((v) => `<option value="${v}" ${selected === v ? "selected" : ""}>${v[0].toUpperCase() + v.slice(1)}</option>`)
    .join("");
}

function addArtifactRow() {
  const container = document.getElementById("artifactRows");
  const div = document.createElement("div");
  div.className = "ba-repeat-row";
  div.innerHTML = `
    <div class="field"><label>Artifact</label>
      <select class="select" data-f="artifact_id">${ref.artifacts.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></div>
    <div class="field"><label>Slot</label>
      <select class="select" data-f="slot_position">
        <option value="">Alt/Bench</option>
        ${[1, 2, 3, 4, 5].map((n) => `<option value="${n}">${n}</option>`).join("")}
      </select></div>
    <div class="field"><label>Importance</label>
      <select class="select" data-f="importance">${importanceOptions("recommended")}</select></div>
    <div class="field"><label>Min Rank</label>
      <input class="input" type="number" step="20" data-f="min_rank" value="160" /></div>
    <div class="field"><label>Notes</label>
      <input class="input" data-f="notes" value="" /></div>
    <button type="button" class="ba-repeat-remove" title="Remove">×</button>
  `;
  div.querySelector(".ba-repeat-remove").addEventListener("click", () => div.remove());
  container.appendChild(div);
}

const REQUIREMENT_TYPE_LABELS = {
  artifact: "Artifact", movement: "Movement", iconic_ability: "Iconic Ability",
  power_array: "Power Array", power_array_ability: "Power Array Ability", ally: "Ally", other: "Other",
};

function addRequirementRow() {
  const container = document.getElementById("requirementRows");
  const div = document.createElement("div");
  div.className = "ba-repeat-row";
  const type = "artifact";
  div.innerHTML = `
    <div class="field"><label>Type</label>
      <select class="select" data-f="requirement_type">
        ${Object.entries(REQUIREMENT_TYPE_LABELS).map(([v, l]) => `<option value="${v}" ${type === v ? "selected" : ""}>${l}</option>`).join("")}
      </select></div>
    <div class="field" data-ref-field><label>Value</label>
      <select class="select" data-f="ref_value"></select></div>
    <div class="field"><label>Importance</label>
      <select class="select" data-f="importance">${importanceOptions("recommended")}</select></div>
    <div class="field"><label>Min Rank</label>
      <input class="input" type="number" min="1" max="200" step="1" data-f="min_rank" value="" placeholder="—" /></div>
    <div class="field"><label>Notes</label>
      <input class="input" data-f="notes" value="" /></div>
    <button type="button" class="ba-repeat-remove" title="Remove">×</button>
  `;
  div.querySelector(".ba-repeat-remove").addEventListener("click", () => div.remove());
  const typeSel = div.querySelector('[data-f="requirement_type"]');
  populateRequirementRefField(div, type, null, null);
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
    ally: ref.allies,
  }[type] || [];
  fieldWrap.innerHTML = `<label>Value</label><select class="select" data-f="ref_value">${options.map((o) => `<option value="${o.id}" ${o.id === selectedId ? "selected" : ""}>${esc(o.name)}</option>`).join("") || `<option value="">Nothing configured yet</option>`}</select>`;
}

function addAlternativeRow() {
  const container = document.getElementById("alternativeRows");
  const div = document.createElement("div");
  div.className = "ba-repeat-row";
  div.innerHTML = `
    <div class="field"><label>Situation (optional)</label>
      <input class="input" data-f="situation" value="" placeholder="Single Target" /></div>
    <div class="field"><label>Replace</label>
      <input class="input" data-f="replace_label" value="" required /></div>
    <div class="field"><label>With</label>
      <input class="input" data-f="with_label" value="" required /></div>
    <div class="field"><label>Notes</label>
      <input class="input" data-f="notes" value="" /></div>
    <button type="button" class="ba-repeat-remove" title="Remove">×</button>
  `;
  div.querySelector(".ba-repeat-remove").addEventListener("click", () => div.remove());
  container.appendChild(div);
}

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
    status: "draft",
    short_description: val("bfShortDesc").trim() || null,
    recommended_for: recommendedFor,
    submitted_by: BuildsAuth.player.username,
    created_by: BuildsAuth.session.user.id,
    why_it_works: val("bfWhyWorks").trim() || null,
    rotation: val("bfRotation").trim() || null,
    strengths: val("bfStrengths").trim() || null,
    weaknesses: val("bfWeaknesses").trim() || null,
    notes: val("bfNotes").trim() || null,
  };

  const loadout = Array.from({ length: 12 }, (_, i) => i + 1).map((n) => ({
    slot_number: n,
    ability_name: document.querySelector(`[data-loadout-name="${n}"]`).value.trim(),
    notes: document.querySelector(`[data-loadout-notes="${n}"]`).value.trim() || null,
  })).filter((s) => s.ability_name);

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
      power_array_id: null, power_array_ability_id: null, ally_id: null, other_label: null,
    };
    if (type === "other") base.other_label = refValue.trim();
    else if (type === "artifact") base.artifact_id = refValue || null;
    else if (type === "movement") base.movement_mode_id = refValue || null;
    else if (type === "iconic_ability") base.iconic_ability_id = refValue || null;
    else if (type === "power_array") base.power_array_id = refValue || null;
    else if (type === "power_array_ability") base.power_array_ability_id = refValue || null;
    else if (type === "ally") base.ally_id = refValue || null;
    return base;
  }).filter((r) => r.other_label || r.artifact_id || r.movement_mode_id || r.iconic_ability_id || r.power_array_id || r.power_array_ability_id || r.ally_id);

  const alternatives = [...document.querySelectorAll("#alternativeRows .ba-repeat-row")].map((row) => ({
    situation: row.querySelector('[data-f="situation"]').value.trim() || null,
    replace_label: row.querySelector('[data-f="replace_label"]').value.trim(),
    with_label: row.querySelector('[data-f="with_label"]').value.trim(),
    notes: row.querySelector('[data-f="notes"]').value.trim() || null,
  })).filter((a) => a.replace_label && a.with_label);

  return { build, loadout, artifacts, requirements, alternatives };
}

async function submitBuild() {
  const btn = document.getElementById("submitBuildBtn");
  const errEl = document.getElementById("submitError");
  errEl.hidden = true;
  btn.disabled = true;
  try {
    const { build, loadout, artifacts, requirements, alternatives } = collectBuildPayload();
    if (!build.name || !build.power_id || !build.role_id || !build.build_type_id) {
      errEl.textContent = "Name, Power, Role, and Build Type are required.";
      errEl.hidden = false;
      btn.disabled = false;
      return;
    }

    const { data, error } = await sb.from("builds").insert(build).select().single();
    if (error) throw error;
    const id = data.id;

    const inserts = [];
    if (loadout.length) inserts.push(sb.from("build_loadout_slots").insert(loadout.map((r) => ({ ...r, build_id: id }))));
    if (artifacts.length) inserts.push(sb.from("build_artifacts").insert(artifacts.map((r) => ({ ...r, build_id: id }))));
    if (requirements.length) inserts.push(sb.from("build_requirements").insert(requirements.map((r) => ({ ...r, build_id: id }))));
    if (alternatives.length) inserts.push(sb.from("build_alternatives").insert(alternatives.map((r) => ({ ...r, build_id: id }))));
    const results = await Promise.all(inserts);
    const failed = results.find((r) => r.error);
    if (failed) throw failed.error;

    document.getElementById("submitRoot").innerHTML = `
      <div class="bp-empty">
        <p class="bp-empty-title">Thanks — your build was submitted!</p>
        <p>"${esc(build.name)}" is now waiting for review. It'll appear on the site once it's approved.</p>
      </div>`;
  } catch (err) {
    errEl.textContent = err.message || "Something went wrong.";
    errEl.hidden = false;
    btn.disabled = false;
  }
}

boot();

