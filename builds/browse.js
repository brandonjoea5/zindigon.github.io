// Zindigon Builds | public browse page.
// Loads published builds + reference data via the shared Supabase client
// from builds-shared.js (esc, fetchReferenceData, fetchVoteTotals, sb —
// all globals from that script tag), renders read-only cards, and offers
// role/build-type filters plus a sort (Newest / Most Upvoted). No auth
// needed to browse — public.builds RLS already allows anon SELECT of
// status = 'published' rows, and build_votes SELECT is public too.

let allBuilds = [];
let ref = null;
let voteTotals = {};

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
    voteTotals = await fetchVoteTotals(allBuilds.map((b) => b.id));
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
  document.getElementById("bpSortFilter").addEventListener("change", render);
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
  const sort = document.getElementById("bpSortFilter") ? document.getElementById("bpSortFilter").value : "newest";

  const filtered = allBuilds.filter((b) => {
    if (roleFilter && b.role_id !== roleFilter) return false;
    if (typeFilter && b.build_type_id !== typeFilter) return false;
    return true;
  });

  if (sort === "upvoted") {
    filtered.sort((a, b) => ((voteTotals[b.id] && voteTotals[b.id].score) || 0) - ((voteTotals[a.id] && voteTotals[a.id].score) || 0));
  } else {
    filtered.sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0));
  }

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
    const totals = voteTotals[b.id] || { up: 0, down: 0, score: 0 };
    return `
    <a class="bp-card" href="detail.html?slug=${encodeURIComponent(b.slug)}">
      <div class="bp-card-top">
        <h3 class="bp-name">${esc(b.name)}</h3>
        <span class="bp-score" title="${totals.up} up / ${totals.down} down">▲ ${totals.score}</span>
      </div>
      <div class="bp-tags">
        ${role ? `<span class="bp-tag role">${esc(role)}</span>` : ""}
        ${power ? `<span class="bp-tag">${esc(power)}</span>` : ""}
        ${buildType ? `<span class="bp-tag">${esc(buildType)}</span>` : ""}
        ${contentType ? `<span class="bp-tag">${esc(contentType)}</span>` : ""}
      </div>
      ${b.short_description ? `<p class="bp-desc">${esc(b.short_description)}</p>` : ""}
      ${updated ? `<span class="bp-updated">Updated ${esc(updated)}</span>` : ""}
    </a>`;
  }).join("");
}

boot();
