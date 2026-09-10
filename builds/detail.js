// Zindigon Builds | public build detail page.
// Reads ?slug=... from the URL, loads that one published build plus its
// loadout/artifacts/requirements/alternatives and reference data via the
// shared Supabase client from builds-shared.js, and renders a read-only
// detail view. No auth, no writes — public.builds RLS already allows
// anon SELECT of status = 'published' rows (and their child rows).

const REQUIREMENT_TYPE_LABELS = {
  artifact: "Artifact", movement: "Movement", iconic_ability: "Iconic Ability",
  power_array: "Power Array", power_array_ability: "Power Array Ability", ally: "Ally", other: "Other",
};

function refName(list, id) {
  const row = (list || []).find((r) => r.id === id);
  return row ? row.name : null;
}

function requirementValueName(ref, r) {
  if (r.requirement_type === "other") return r.other_label || "—";
  if (r.requirement_type === "artifact") return refName(ref.artifacts, r.artifact_id) || "—";
  if (r.requirement_type === "movement") return refName(ref.movementModes, r.movement_mode_id) || "—";
  if (r.requirement_type === "iconic_ability") return refName(ref.iconicAbilities, r.iconic_ability_id) || "—";
  if (r.requirement_type === "power_array") return refName(ref.powerArrays, r.power_array_id) || "—";
  if (r.requirement_type === "power_array_ability") {
    const a = (ref.powerArrayAbilities || []).find((x) => x.id === r.power_array_ability_id);
    return a ? `${a.ability_name} (rank ${a.required_rank}+)` : "—";
  }
  if (r.requirement_type === "ally") return refName(ref.allies, r.ally_id) || "—";
  return "—";
}

function qs(name) {
  return new URLSearchParams(window.location.search).get(name);
}

async function boot() {
  const root = document.getElementById("buildDetail");
  const slug = (qs("slug") || "").trim();

  if (!slug) {
    root.innerHTML = notFoundMarkup("No build specified.");
    return;
  }

  try {
    const [{ data: build, error: bErr }, ref] = await Promise.all([
      sb.from("builds").select("*").eq("slug", slug).eq("status", "published").maybeSingle(),
      fetchReferenceData(),
    ]);
    if (bErr) throw bErr;
    if (!build) {
      root.innerHTML = notFoundMarkup("That build doesn't exist, or isn't published.");
      return;
    }

    const [loadout, artifacts, requirements, alternatives] = await Promise.all([
      sb.from("build_loadout_slots").select("*").eq("build_id", build.id).order("slot_number"),
      sb.from("build_artifacts").select("*").eq("build_id", build.id),
      sb.from("build_requirements").select("*").eq("build_id", build.id),
      sb.from("build_alternatives").select("*").eq("build_id", build.id),
    ]);

    document.title = `${build.name} | Zindigon Builds`;
    render(build, ref, {
      loadout: loadout.data || [],
      artifacts: artifacts.data || [],
      requirements: requirements.data || [],
      alternatives: alternatives.data || [],
    });
  } catch (err) {
    root.innerHTML = notFoundMarkup(err.message || "Something went wrong talking to the database. Try refreshing.");
  }
}

function notFoundMarkup(message) {
  return `<div class="bp-empty">
    <p class="bp-empty-title">Couldn't load that build</p>
    <p>${esc(message)}</p>
    <p style="margin-top:16px;"><a class="link-arrow" href="index.html">← Back to all builds</a></p>
  </div>`;
}

function render(build, ref, children) {
  const power = refName(ref.powers, build.power_id);
  const role = refName(ref.roles, build.role_id);
  const buildType = refName(ref.buildTypes, build.build_type_id);
  const contentType = refName(ref.contentTypes, build.content_type_id);
  const updated = build.updated_at
    ? new Date(build.updated_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : null;
  const tested = build.last_tested_date
    ? new Date(build.last_tested_date + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : null;

  const slotAt = (n) => children.loadout.find((s) => s.slot_number === n);
  const loadoutTray = (tray) => [1, 2, 3, 4, 5, 6].map((n) => {
    const slotNumber = tray === 1 ? n : n + 6;
    const slot = slotAt(slotNumber);
    if (!slot || !slot.ability_name) return "";
    return `
      <div class="bd-loadout-slot">
        <span class="num">${n}.</span>
        <span class="bd-loadout-name">${esc(slot.ability_name)}</span>
        ${slot.notes ? `<span class="bd-loadout-notes">${esc(slot.notes)}</span>` : ""}
      </div>`;
  }).join("");

  const artifactsMarkup = children.artifacts.length ? `
    <div class="bd-table-wrap">
      <table class="bd-table">
        <thead><tr><th>Artifact</th><th>Slot</th><th>Importance</th><th>Min Rank</th><th>Notes</th></tr></thead>
        <tbody>
          ${children.artifacts
            .slice()
            .sort((a, b) => (a.slot_position ?? 99) - (b.slot_position ?? 99))
            .map((a) => `
            <tr>
              <td>${esc(refName(ref.artifacts, a.artifact_id) || "—")}</td>
              <td>${a.slot_position ? esc(String(a.slot_position)) : "Alt/Bench"}</td>
              <td><span class="bd-pill ${esc(a.importance || "")}">${esc(a.importance || "—")}</span></td>
              <td>${a.min_rank ?? "—"}</td>
              <td class="muted">${esc(a.notes || "—")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : `<p class="hint">No artifacts listed for this build.</p>`;

  const requirementsMarkup = children.requirements.length ? `
    <div class="bd-table-wrap">
      <table class="bd-table">
        <thead><tr><th>Type</th><th>Value</th><th>Importance</th><th>Min Rank</th><th>Notes</th></tr></thead>
        <tbody>
          ${children.requirements.map((r) => `
            <tr>
              <td>${esc(REQUIREMENT_TYPE_LABELS[r.requirement_type] || r.requirement_type)}</td>
              <td>${esc(requirementValueName(ref, r))}</td>
              <td><span class="bd-pill ${esc(r.importance || "")}">${esc(r.importance || "—")}</span></td>
              <td>${r.min_rank ?? "—"}</td>
              <td class="muted">${esc(r.notes || "—")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : `<p class="hint">No specific requirements listed for this build.</p>`;

  const alternativesMarkup = children.alternatives.length ? `
    <div class="bd-table-wrap">
      <table class="bd-table">
        <thead><tr><th>Situation</th><th>Replace</th><th>With</th><th>Notes</th></tr></thead>
        <tbody>
          ${children.alternatives.map((a) => `
            <tr>
              <td>${esc(a.situation || "Any")}</td>
              <td>${esc(a.replace_label)}</td>
              <td>${esc(a.with_label)}</td>
              <td class="muted">${esc(a.notes || "—")}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>` : "";

  const writeUpSections = [
    ["Why This Build Works", build.why_it_works],
    ["Rotation", build.rotation],
    ["Strengths", build.strengths],
    ["Weaknesses", build.weaknesses],
    ["Notes", build.notes],
  ].filter(([, text]) => text && text.trim());

  document.getElementById("buildDetail").innerHTML = `
    <p><a class="link-arrow" href="index.html">← Back to all builds</a></p>

    <div class="bd-header">
      <h1 class="display bd-title">${esc(build.name)}</h1>
      <div class="bp-tags">
        ${role ? `<span class="bp-tag role">${esc(role)}</span>` : ""}
        ${power ? `<span class="bp-tag">${esc(power)}</span>` : ""}
        ${buildType ? `<span class="bp-tag">${esc(buildType)}</span>` : ""}
        ${contentType ? `<span class="bp-tag">${esc(contentType)}</span>` : ""}
        ${build.difficulty ? `<span class="bp-tag">${esc(build.difficulty[0].toUpperCase() + build.difficulty.slice(1))}</span>` : ""}
      </div>
      ${build.short_description ? `<p class="bd-lede">${esc(build.short_description)}</p>` : ""}
      <div class="bp-hero-meta">
        ${updated ? `<span>Updated ${esc(updated)}</span>` : ""}
        ${tested ? `<span>Last tested ${esc(tested)}</span>` : ""}
      </div>
            <p class="bd-submitted-by">Submitted by ${esc(build.submitted_by || "Anonymous")}</p>
${(build.recommended_for || []).length ? `
        <div class="bd-recommended">
          <span class="bd-recommended-label">Recommended for:</span>
          ${build.recommended_for.map((r) => `<span class="bp-tag">${esc(r)}</span>`).join("")}
        </div>` : ""}
    </div>

    <section class="bd-section">
      <h2>Loadout</h2>
      <div class="bd-loadout-grid">
        <div>
          <div class="bd-tray-label">Tray 1</div>
          ${loadoutTray(1) || `<p class="hint">Not documented yet.</p>`}
        </div>
        <div>
          <div class="bd-tray-label">Tray 2</div>
          ${loadoutTray(2) || `<p class="hint">Not documented yet.</p>`}
        </div>
      </div>
    </section>

    <section class="bd-section">
      <h2>Artifacts</h2>
      ${artifactsMarkup}
    </section>

    <section class="bd-section">
      <h2>Requirements</h2>
      ${requirementsMarkup}
    </section>

    ${children.alternatives.length ? `
    <section class="bd-section">
      <h2>Situational Swaps &amp; Alternatives</h2>
      ${alternativesMarkup}
    </section>` : ""}

    ${writeUpSections.length ? `
    <section class="bd-section">
      <h2>Write-up</h2>
      ${writeUpSections.map(([label, text]) => `
        <div class="bd-writeup-block">
          <h3>${esc(label)}</h3>
          <p>${esc(text).replace(/\n/g, "<br>")}</p>
        </div>`).join("")}
    </section>` : ""}
  `;
}

boot();

