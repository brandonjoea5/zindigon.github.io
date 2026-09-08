// Zindigon Builds | public browse page.
// Loads published builds + reference data via the shared Supabase client
// from builds-shared.js (esc, fetchReferenceData, sb — all globals from
// that script tag), renders read-only cards, and offers simple
// role/build-type filters. No auth, no writes — public.builds RLS already
// allows anon SELECT of status = 'published' rows.

let allBuilds = [];
let ref = null;

async function boot() {
  const grid = document.getElementById("buildGrid");
  try {
    const [buildsRes, refData] = await Promise.all([
      sb.from("builds").select("*").eq("status", "published").order("updated_at", { ascending: false }),
      fetchReferenceData(),
    ]);
    if (buildsRes.error) throw buildsRes.error;
    allBuilds = buildsRes.data || [];
    ref = refData;
  } catch (err) {
    grid.innerHTML = `<div class="bp-empty">
      <p class="bp-empty-title">Couldn't load builds</p>
      <p>${esc(err.message || "Something went wrong talking to the database. Try refreshing.")}</p>
    </div>`;
    return;
  }

  populateFilters();
  render();

  document.getElementById("bpRoleFilter").addEventListener("change", render);
  document.getElementById("bpTypeFilter").addEventListener("change", render);
}

function refName(list, id) {
  const row = list.find((r) => r.id === id);
  return row ? row.name : null;
}

function populateFilters() {
  const roleSel = document.getElementById("bpRoleFilter");
  const typeSel = document.getElementById("bpTypeFilter");
  roleSel.innerHTML = `<option value="">All roles</option>` +
    ref.roles.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join("");
  typeSel.innerHTML = `<option value="">All build types</option>` +
    ref.buildTypes.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
}

function render() {
  const grid = document.getElementById("buildGrid");
  const countEl = document.getElementById("buildCount");
  const roleFilter = document.getElementById("bpRoleFilter").value;
  const typeFilter = document.getElementById("bpTypeFilter").value;

  const filtered = allBuilds.filter((b) => {
    if (roleFilter && b.role_id !== roleFilter) return false;
    if (typeFilter && b.build_type_id !== typeFilter) return false;
    return true;
  });

  countEl.textContent = filtered.length === 1 ? "1 build" : `${filtered.length} builds`;

  if (!allBuilds.length) {
    grid.innerHTML = `<div class="bp-empty">
      <p class="bp-empty-title">No builds published yet</p>
      <p>The Zindigon Builds database is brand new — check back soon, or if you're a Zindigon admin, publish your first build from the admin panel.</p>
    </div>`;
    return;
  }

  if (!filtered.length) {
    grid.innerHTML = `<div class="bp-empty">
      <p class="bp-empty-title">No builds match those filters</p>
      <p>Try a different role or build type.</p>
    </div>`;
    return;
  }

  grid.innerHTML = filtered.map((b) => {
    const power = refName(ref.powers, b.power_id);
    const role = refName(ref.roles, b.role_id);
    const buildType = refName(ref.buildTypes, b.build_type_id);
    const contentType = refName(ref.contentTypes, b.content_type_id);
    const updated = b.updated_at ? new Date(b.updated_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
    return `
    <div class="bp-card">
      <h3 class="bp-name">${esc(b.name)}</h3>
      <div class="bp-tags">
        ${role ? `<span class="bp-tag role">${esc(role)}</span>` : ""}
        ${power ? `<span class="bp-tag">${esc(power)}</span>` : ""}
        ${buildType ? `<span class="bp-tag">${esc(buildType)}</span>` : ""}
        ${contentType ? `<span class="bp-tag">${esc(contentType)}</span>` : ""}
      </div>
      ${b.short_description ? `<p class="bp-desc">${esc(b.short_description)}</p>` : ""}
      ${updated ? `<span class="bp-updated">Updated ${esc(updated)}</span>` : ""}
    </div>`;
  }).join("");
}

boot();

